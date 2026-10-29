import {
  BillingSubscriptionStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import {
  type PaymentGateway,
} from '../billing/payments';
import {
  parseRenewalEventHint,
  type UntrustedRenewalEventHint,
} from './paystack-renewal.service';
import {
  PaystackRenewalVerifier,
  type RenewalVerificationDatabase,
  type VerifiedRenewalSubscriptionProof,
  type VerifiedRenewalTransactionProof,
} from './paystack-renewal-verifier.service';

export type RenewalEvidenceDatabase = PrismaClient | Prisma.TransactionClient;

export type AuthenticatedRenewalEvidenceOutcome =
  | 'AUTHENTICATED_EVIDENCE_PRODUCED'
  | 'MISSING_SIGNATURE_PROVENANCE'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'MALFORMED_INVOICE_EVIDENCE'
  | 'INCOMPLETE_INVOICE_STATE'
  | 'PROVIDER_OUTAGE'
  | 'DEFINITIVE_CONTRADICTION'
  | 'CONFLICT';

export interface AuthenticatedWebhookAssociation {
  readonly webhookEventId: string;
  readonly signatureVerifiedAt: Date;
  readonly eventType: 'invoice.update';
  readonly invoiceCode: string;
  readonly invoiceId?: string;
  readonly subscriptionCode: string;
  readonly transactionReference: string;
  readonly customerCode: string;
  readonly amountCents: number;
  readonly currency: 'USD';
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly invoicePaidAt?: Date;
}

export interface AuthenticatedRenewalEvidenceResult {
  readonly outcome: AuthenticatedRenewalEvidenceOutcome;
  readonly isReadyForSettlement: false;
  readonly webhookAssociation?: AuthenticatedWebhookAssociation;
  readonly subscriptionProof?: VerifiedRenewalSubscriptionProof;
  readonly transactionProof?: VerifiedRenewalTransactionProof;
  readonly isReplayCandidate?: boolean;
  readonly unresolvedFacts: readonly string[];
  readonly error?: string;
}

export const DEFAULT_UNRESOLVED_FACTS: readonly string[] = [
  'UNRESOLVED_INVOICE_OWNERSHIP: Paystack provides no read-only GET API for subscription invoices; invoice-to-transaction linkage is established by authenticated webhook co-location, not an independent provider lookup.',
  'UNRESOLVED_CYCLE_ENTITLEMENT: Transaction settlement, local BillingPeriod monotonic sequence allocation, and financial ledger posting remain pending; webhook association alone does not grant entitlement or advance billing cycles.',
];

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export class PaystackAuthenticatedRenewalEvidenceService {
  private readonly verifier: PaystackRenewalVerifier;

  constructor(
    private readonly database: RenewalEvidenceDatabase,
    private readonly gateway: PaymentGateway,
    verifier?: PaystackRenewalVerifier
  ) {
    this.verifier = verifier ?? new PaystackRenewalVerifier(database, gateway);
  }

  async collectRenewalEvidence(input: {
    webhookEventId: string;
  }): Promise<AuthenticatedRenewalEvidenceResult> {
    // 1. Verify Signature Provenance via BillingWebhookEvent
    // An event qualifies as authenticated evidence ONLY if it was persisted through
    // PaystackWebhookService.receive(), which validates the HMAC-SHA512 signature.
    if (!input.webhookEventId || typeof input.webhookEventId !== 'string') {
      return {
        outcome: 'MISSING_SIGNATURE_PROVENANCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'A valid webhookEventId is required to verify signature provenance',
      };
    }

    const webhookRecord = await this.database.billingWebhookEvent.findUnique({
      where: { id: input.webhookEventId },
    });

    if (!webhookRecord) {
      return {
        outcome: 'MISSING_SIGNATURE_PROVENANCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `Webhook event ${input.webhookEventId} was not found in BillingWebhookEvent`,
      };
    }

    const sigDate = webhookRecord.signatureVerifiedAt instanceof Date
      ? webhookRecord.signatureVerifiedAt
      : (typeof webhookRecord.signatureVerifiedAt === 'string' ? new Date(webhookRecord.signatureVerifiedAt) : null);

    if (
      webhookRecord.provider !== 'paystack' ||
      !sigDate ||
      Number.isNaN(sigDate.getTime())
    ) {
      return {
        outcome: 'MISSING_SIGNATURE_PROVENANCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `Webhook event ${input.webhookEventId} lacks verified signature provenance`,
      };
    }

    // 2. Validate Event Type
    // Only invoice.update carries co-located invoice, subscription, and transaction evidence
    // for renewal cycles.
    if (webhookRecord.eventType !== 'invoice.update') {
      return {
        outcome: 'UNSUPPORTED_EVENT_TYPE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `Unsupported webhook event type: ${webhookRecord.eventType}. Only invoice.update provides authenticated cycle evidence.`,
      };
    }

    // 3. Parse Webhook Payload
    const rawPayload = webhookRecord.payload;
    if (!isRecord(rawPayload)) {
      return {
        outcome: 'MALFORMED_INVOICE_EVIDENCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'Webhook event payload is not a valid JSON object',
      };
    }

    let hint: UntrustedRenewalEventHint;
    try {
      hint = parseRenewalEventHint({
        event: webhookRecord.eventType,
        data: isRecord(rawPayload.data) ? rawPayload.data : rawPayload,
      });
    } catch (error) {
      return {
        outcome: 'MALFORMED_INVOICE_EVIDENCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `Failed to parse renewal event hint: ${(error as Error).message}`,
      };
    }

    // 4. Validate Co-located Evidence Completeness
    if (!hint.subscription?.subscriptionCode) {
      return {
        outcome: 'MALFORMED_INVOICE_EVIDENCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'invoice.update payload lacks a provider subscription code',
      };
    }

    if (!hint.invoice?.invoiceCode) {
      return {
        outcome: 'MALFORMED_INVOICE_EVIDENCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'invoice.update payload lacks a provider invoice code',
      };
    }

    if (!hint.transaction?.reference) {
      return {
        outcome: 'MALFORMED_INVOICE_EVIDENCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'invoice.update payload lacks a candidate transaction reference',
      };
    }

    if (!hint.customer?.customerCode) {
      return {
        outcome: 'MALFORMED_INVOICE_EVIDENCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'invoice.update payload lacks a customer code',
      };
    }

    if (!hint.amountCents || hint.amountCents <= 0) {
      return {
        outcome: 'MALFORMED_INVOICE_EVIDENCE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'invoice.update payload lacks a valid amount in cents',
      };
    }

    if (hint.currency !== 'USD') {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `invoice.update currency is ${hint.currency}; expected USD`,
      };
    }

    // 5. Require Unambiguous Successful Invoice & Payment State
    if (hint.invoice.paid !== true) {
      return {
        outcome: 'INCOMPLETE_INVOICE_STATE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `invoice.update indicates unpaid or missing paid status (paid=${String(hint.invoice.paid)})`,
      };
    }

    if (!hint.invoice.status || !['paid', 'success'].includes(hint.invoice.status)) {
      return {
        outcome: 'INCOMPLETE_INVOICE_STATE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `invoice.update status is "${String(hint.invoice.status)}"; expected "paid" or "success"`,
      };
    }

    if (hint.transaction.status !== 'success') {
      return {
        outcome: 'INCOMPLETE_INVOICE_STATE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: `invoice.update candidate transaction status is "${String(hint.transaction.status)}"; expected "success"`,
      };
    }

    // 6. Check Provider Invoice Conflicts Across Subscriptions
    const existingInvoice = await this.database.billingInvoice.findUnique({
      where: { providerInvoiceId: hint.invoice.invoiceCode },
    });

    let isInvoiceReplay = false;
    if (existingInvoice) {
      // Find local subscription to verify ownership
      const localSub = await this.database.billingSubscription.findUnique({
        where: { providerSubscriptionId: hint.subscription.subscriptionCode },
      });
      if (!localSub || existingInvoice.subscriptionId !== localSub.id) {
        return {
          outcome: 'CONFLICT',
          isReadyForSettlement: false,
          unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
          error: `Provider invoice code ${hint.invoice.invoiceCode} is already bound to another subscription (${existingInvoice.subscriptionId})`,
        };
      }
      isInvoiceReplay = true;
    }

    // 7. Perform Independent Read-Only Paystack Lookups
    const verifierResult = await this.verifier.verifyRenewal(hint);

    if (verifierResult.outcome === 'PROVIDER_OUTAGE') {
      return {
        outcome: 'PROVIDER_OUTAGE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: verifierResult.error,
      };
    }

    if (verifierResult.outcome === 'DEFINITIVE_CONTRADICTION') {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: verifierResult.error,
      };
    }

    if (verifierResult.outcome === 'CONFLICT') {
      return {
        outcome: 'CONFLICT',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: verifierResult.error,
      };
    }

    if (!verifierResult.subscriptionProof || !verifierResult.transactionProof) {
      return {
        outcome: 'INCOMPLETE_INVOICE_STATE',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'Failed to obtain verified subscription or transaction proof from Paystack',
      };
    }

    // 8. Assemble Authenticated Webhook Association
    const webhookAssociation: AuthenticatedWebhookAssociation = {
      webhookEventId: webhookRecord.id,
      signatureVerifiedAt: sigDate,
      eventType: 'invoice.update',
      invoiceCode: hint.invoice.invoiceCode,
      ...(hint.invoice.invoiceId ? { invoiceId: hint.invoice.invoiceId } : {}),
      subscriptionCode: hint.subscription.subscriptionCode,
      transactionReference: hint.transaction.reference,
      customerCode: hint.customer.customerCode,
      amountCents: hint.amountCents,
      currency: 'USD',
      ...(hint.period?.periodStart ? { periodStart: hint.period.periodStart } : {}),
      ...(hint.period?.periodEnd ? { periodEnd: hint.period.periodEnd } : {}),
      ...(hint.invoice.paidAt ? { invoicePaidAt: hint.invoice.paidAt } : {}),
    };

    if (
      webhookAssociation.customerCode !== verifierResult.subscriptionProof.providerCustomerId ||
      webhookAssociation.customerCode !== verifierResult.transactionProof.providerCustomerId ||
      webhookAssociation.amountCents !== verifierResult.subscriptionProof.amountCents ||
      webhookAssociation.amountCents !== verifierResult.transactionProof.amountCents ||
      webhookAssociation.subscriptionCode !== verifierResult.subscriptionProof.subscriptionCode ||
      webhookAssociation.transactionReference !== verifierResult.transactionProof.reference
    ) {
      return {
        outcome: 'DEFINITIVE_CONTRADICTION',
        isReadyForSettlement: false,
        unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
        error: 'Authenticated webhook association attributes contradict verified subscription or transaction proof',
      };
    }

    const isReplay = Boolean(verifierResult.isReplayCandidate || isInvoiceReplay);

    return {
      outcome: 'AUTHENTICATED_EVIDENCE_PRODUCED',
      isReadyForSettlement: false,
      webhookAssociation,
      subscriptionProof: verifierResult.subscriptionProof,
      transactionProof: verifierResult.transactionProof,
      ...(isReplay ? { isReplayCandidate: true } : {}),
      unresolvedFacts: DEFAULT_UNRESOLVED_FACTS,
    };
  }
}
