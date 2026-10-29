import { PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '../database/prisma';
import type { PaymentGateway } from '../billing/payments';
import {
  PermanentWebhookError,
  RetryableWebhookError,
  type WebhookEventProcessor,
} from '../jobs/webhook-event-processor';
import {
  PaystackWebhookRouter,
  type WebhookRouterDatabase,
} from './paystack-webhook-router.service';
import {
  PaystackReconciliationProcessor,
  type ReconciliationDatabase,
} from './paystack-reconciliation.service';
import {
  PaystackAuthenticatedRenewalEvidenceService,
  type RenewalEvidenceDatabase,
} from './paystack-renewal-evidence.service';
import {
  PaystackRenewalSettlementService,
  type SettlementDatabase,
} from './paystack-renewal-settlement.service';
import {
  evaluateRenewalPairing,
  type RenewalVerificationDatabase,
} from './paystack-renewal-verifier.service';
import {
  RENEWAL_BILLING_POLICIES,
  type RenewalBillingPolicy,
} from '../billing/billing-calendar';

export const PAYSTACK_PROVIDER = 'paystack';

export interface WebhookEventItem {
  readonly id: string;
  readonly provider: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export type WebhookProcessorDatabase =
  | PrismaClient
  | ReconciliationDatabase
  | RenewalEvidenceDatabase
  | SettlementDatabase
  | WebhookRouterDatabase;

export interface PaystackWebhookProcessorOptions {
  readonly billingPolicy?: RenewalBillingPolicy;
  readonly router?: PaystackWebhookRouter;
  readonly reconciliationProcessor?: PaystackReconciliationProcessor;
  readonly evidenceService?: PaystackAuthenticatedRenewalEvidenceService;
  readonly settlementService?: PaystackRenewalSettlementService;
}

/**
 * PaystackWebhookEventProcessor
 *
 * Safe orchestration layer for all Paystack webhook events:
 * 1. Initial checkout reconciliation & subscription.create linkage (delegated to verified reconciliation engine).
 * 2. Authenticated renewal evidence collection via stored HMAC-verified event ID.
 * 3. Strict proof-gate enforcement for recurring renewals (fail-closed refusal while provider invoice proof is missing).
 * 4. Proven exact replay acknowledgment with zero duplicate writes.
 * 5. Ambiguous charge rejection without marking as financially processed.
 * 6. Non-mutating handling of invoice.payment_failed (dunning pending).
 */
export class PaystackWebhookEventProcessor implements WebhookEventProcessor {
  private readonly router: PaystackWebhookRouter;
  private readonly reconciliationProcessor: PaystackReconciliationProcessor;
  private readonly evidenceService: PaystackAuthenticatedRenewalEvidenceService;
  private readonly settlementService: PaystackRenewalSettlementService;
  private readonly billingPolicy: RenewalBillingPolicy;

  constructor(
    private readonly database: WebhookProcessorDatabase = defaultPrisma,
    gateway: PaymentGateway,
    options: PaystackWebhookProcessorOptions = {}
  ) {
    this.router = options.router ?? new PaystackWebhookRouter(database as WebhookRouterDatabase);
    this.reconciliationProcessor =
      options.reconciliationProcessor ??
      new PaystackReconciliationProcessor(database as ReconciliationDatabase, gateway);
    this.evidenceService =
      options.evidenceService ??
      new PaystackAuthenticatedRenewalEvidenceService(database as RenewalEvidenceDatabase, gateway);
    this.settlementService =
      options.settlementService ??
      new PaystackRenewalSettlementService(database as SettlementDatabase);
    this.billingPolicy = options.billingPolicy ?? RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING;
  }

  async process(event: WebhookEventItem): Promise<void> {
    if (!event || typeof event !== 'object') {
      throw new PermanentWebhookError('Malformed webhook work item: event is undefined or not an object');
    }

    if (event.provider !== PAYSTACK_PROVIDER) {
      throw new PermanentWebhookError(
        `Unsupported webhook provider: ${event.provider}; expected ${PAYSTACK_PROVIDER}`
      );
    }

    const classification = await this.router.classify(event);

    switch (classification.route) {
      case 'INITIAL_CHECKOUT_RECONCILIATION':
        // Verified initial checkout reconciliation
        await this.reconciliationProcessor.process(event);
        return;

      case 'SUBSCRIPTION_CREATE_LINKAGE':
        // Verified provider subscription linkage to existing reconciled customer
        await this.reconciliationProcessor.process(event);
        return;

      case 'SUBSCRIPTION_CREATE_UNRECOGNIZED':
        // Delegate to reconciliation processor which will throw RetryableWebhookError
        // waiting for initial checkout payment to reconcile the customer identity
        await this.reconciliationProcessor.process(event);
        return;

      case 'RENEWAL_PAYMENT_REPLAY':
        // Full pairing validation before acknowledging replay
        await this.verifyRenewalPaymentReplay(classification.subscriptionId, classification.reference);
        return;

      case 'UNRESOLVED_CHARGE_AMBIGUOUS':
        // Ambiguous or unresolved financial events must not be acknowledged as financially processed.
        throw new PermanentWebhookError(`Ambiguous charge event unresolved: ${classification.reason}`);

      case 'RENEWAL_INVOICE_UPDATE':
        // Signature-authenticated renewal evidence collection & settlement gate enforcement
        await this.processRenewalInvoiceUpdate(event);
        return;

      case 'RENEWAL_PAYMENT_FAILED':
        // Non-mutating: zero database writes. Preserves auditable terminal failed state.
        throw new PermanentWebhookError(
          'Renewal invoice payment failed; dunning policy pending implementation'
        );

      case 'UNSUPPORTED_EVENT_TYPE':
        throw new PermanentWebhookError(`Unsupported webhook event: ${classification.reason}`);

      case 'MALFORMED_EVENT_PAYLOAD':
        throw new PermanentWebhookError(`Malformed webhook payload: ${classification.reason}`);

      default: {
        const exhaustiveCheck: never = classification;
        throw new PermanentWebhookError(
          `Unhandled webhook classification route: ${(exhaustiveCheck as { route: string }).route}`
        );
      }
    }
  }

  private async verifyRenewalPaymentReplay(subscriptionId: string, reference: string): Promise<void> {
    const attempt = await (this.database as any).billingPaymentAttempt.findUnique({
      where: { providerReference: reference },
      include: { invoice: true },
    });

    if (!attempt || !attempt.providerPaymentId) {
      throw new PermanentWebhookError(
        `Renewal payment replay missing local payment attempt or provider transaction ID for reference ${reference}`
      );
    }

    const pairing = await evaluateRenewalPairing(this.database as RenewalVerificationDatabase, {
      localSubscriptionId: subscriptionId,
      invoiceCode: attempt.invoice?.providerInvoiceId ?? undefined,
      providerTransactionId: attempt.providerPaymentId,
      providerReference: reference,
    });

    if (pairing.status === 'EXACT_REPLAY') {
      // Proven exact replay: all records consistently match. Acknowledged cleanly with zero duplicate writes.
      return;
    }

    if (pairing.status === 'CONFLICT' || pairing.status === 'INCOMPLETE') {
      throw new PermanentWebhookError(`Renewal payment replay rejected: ${pairing.error}`);
    }

    throw new PermanentWebhookError(
      'Renewal payment replay verification failed: unexpected first-time pairing state on established reference'
    );
  }

  private async processRenewalInvoiceUpdate(event: WebhookEventItem): Promise<void> {
    // 1. Collect signature-authenticated renewal evidence using stored event ID
    const evidence = await this.evidenceService.collectRenewalEvidence({
      webhookEventId: event.id,
    });

    if (evidence.outcome === 'PROVIDER_OUTAGE') {
      throw new RetryableWebhookError(
        `Paystack provider outage during renewal evidence collection: ${evidence.error ?? 'network error'}`
      );
    }

    if (evidence.outcome !== 'AUTHENTICATED_EVIDENCE_PRODUCED') {
      throw new PermanentWebhookError(
        `Authenticated renewal evidence collection failed: ${evidence.outcome} - ${evidence.error ?? 'validation failure'}`
      );
    }

    // 2. Evaluate renewal settlement against the production proof gate
    const settlementResult = await this.settlementService.settleRenewalCycle({
      evidence,
      billingPolicy: this.billingPolicy,
    });

    if (settlementResult.status === 'EXACT_REPLAY_ACKNOWLEDGED') {
      // Proven exact replay through settlement pairing: acknowledged cleanly with zero duplicate writes
      return;
    }

    if (settlementResult.status === 'SETTLED') {
      // Real renewal settlement is disabled while independent provider invoice proof is unavailable.
      // If proof gate ever allowed settlement, it completes cleanly.
      return;
    }

    // Proof gate refusal or conflict rejection:
    // Must NOT be acknowledged as financially processed.
    // Throws PermanentWebhookError to ensure queue transitions to FAILED terminal with auditable reason.
    throw new PermanentWebhookError(
      `Renewal settlement refused by proof gate: ${settlementResult.reason}`
    );
  }
}
