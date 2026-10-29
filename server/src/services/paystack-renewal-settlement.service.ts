import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingLedgerTransactionType,
  BillingPaymentAttemptStatus,
  BillingPeriodStatus,
  BillingSubscriptionStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../database/prisma';
import {
  PermanentWebhookError,
  RetryableWebhookError,
} from '../jobs/webhook-event-processor';
import {
  calculateNextBillingPeriod,
  RENEWAL_BILLING_POLICIES,
  type RenewalBillingPolicy,
} from '../billing/billing-calendar';
import {
  evaluateRenewalPairing,
  type RenewalVerificationDatabase,
} from './paystack-renewal-verifier.service';
import type { AuthenticatedRenewalEvidenceResult } from './paystack-renewal-evidence.service';

export const CASH_ACCOUNT = 'cash';
export const ACCOUNTS_RECEIVABLE_ACCOUNT = 'accounts_receivable';
export const TRANSACTION_RETRIES = 5;

export type SettlementDatabase = PrismaClient | Prisma.TransactionClient;
export type SettlementTransactionRunner = <T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
) => Promise<T>;

export interface RenewalSettlementInput {
  readonly evidence: AuthenticatedRenewalEvidenceResult;
  readonly billingPolicy: RenewalBillingPolicy;
}

export interface RenewalSettlementSuccessResult {
  readonly status: 'SETTLED';
  readonly periodId: string;
  readonly sequence: number;
  readonly invoiceId: string;
  readonly paymentAttemptId: string;
  readonly ledgerTransactionId: string;
  readonly subscriptionStatus: BillingSubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
}

export interface RenewalSettlementReplayResult {
  readonly status: 'EXACT_REPLAY_ACKNOWLEDGED';
  readonly invoiceId: string;
  readonly paymentAttemptId: string;
  readonly reason: string;
}

export interface RenewalSettlementRefusalResult {
  readonly status:
    | 'SETTLEMENT_REFUSED_PROOF_GATE'
    | 'SETTLEMENT_REJECTED_CONFLICT'
    | 'SETTLEMENT_REJECTED_INCOMPLETE';
  readonly reason: string;
  readonly error?: string;
}

export type RenewalSettlementResult =
  | RenewalSettlementSuccessResult
  | RenewalSettlementReplayResult
  | RenewalSettlementRefusalResult;

interface HistoricalPriceSnapshot {
  monthlyPriceCents: number;
  includedStaffSeats: number;
  extraStaffSeatPriceCents: number;
  currency: string;
}

interface HistoricalPricingBreakdown {
  billableStaffSeats: number;
  extraStaffSeats: number;
  extraStaffAmountCents: number;
  monthlyTotalCents: number;
}

export const calculateHistoricalRenewalPricing = (
  price: HistoricalPriceSnapshot,
  billableStaffSeats: number
): HistoricalPricingBreakdown => {
  if (
    price.currency !== 'USD' ||
    !Number.isSafeInteger(price.monthlyPriceCents) ||
    price.monthlyPriceCents < 0 ||
    !Number.isSafeInteger(price.includedStaffSeats) ||
    price.includedStaffSeats < 0 ||
    !Number.isSafeInteger(price.extraStaffSeatPriceCents) ||
    price.extraStaffSeatPriceCents < 0 ||
    !Number.isSafeInteger(billableStaffSeats) ||
    billableStaffSeats < 0
  ) {
    throw new PermanentWebhookError('Persisted billing price or seat snapshot is invalid');
  }

  const extraStaffSeats = Math.max(0, billableStaffSeats - price.includedStaffSeats);
  if (price.extraStaffSeatPriceCents === 0 && extraStaffSeats > 0) {
    throw new PermanentWebhookError('Persisted billing seat snapshot exceeds its historical plan allowance');
  }
  const extraStaffAmountCents = extraStaffSeats * price.extraStaffSeatPriceCents;
  const monthlyTotalCents = price.monthlyPriceCents + extraStaffAmountCents;
  if (!Number.isSafeInteger(extraStaffAmountCents) || !Number.isSafeInteger(monthlyTotalCents)) {
    throw new PermanentWebhookError('Persisted billing price exceeds safe monetary limits');
  }
  return { billableStaffSeats, extraStaffSeats, extraStaffAmountCents, monthlyTotalCents };
};

export class PaystackRenewalSettlementService {
  constructor(
    protected readonly database: SettlementDatabase = defaultPrisma,
    protected readonly transactionRunner?: SettlementTransactionRunner,
    protected readonly nowProvider: () => Date = () => new Date()
  ) {}

  /**
   * Public production entry point for recurring renewal settlement.
   *
   * Strictly fail-closed: requires verified provider invoice cycle ownership proof.
   * Because Paystack provides no read-only API to independently confirm subscription
   * invoice cycle ownership, the evidence layer returns isReadyForSettlement: false.
   * Therefore, this production entry point unconditionally refuses settlement.
   *
   * Any caller attempting to pass synthetic/untrusted evidence or extra bypass properties
   * is rejected immediately without performing any database writes or queries.
   */
  async settleRenewalCycle(input: RenewalSettlementInput): Promise<RenewalSettlementResult> {
    // 1. Strict Fail-Closed Production Proof Gate
    // Requires authenticated, approved renewal evidence with independent invoice cycle ownership proof.
    // Under no circumstances can a production caller bypass this gate by supplying extra properties,
    // user-provided readiness flags, or unready evidence.
    if (!input || typeof input !== 'object') {
      return {
        status: 'SETTLEMENT_REFUSED_PROOF_GATE',
        reason: 'Production settlement gate refused: missing or invalid settlement input',
      };
    }

    // Reject any unauthorized caller properties or bypass flags
    const forbiddenCallerProps = [
      'allowTestFixtureProof',
      'bypass',
      'force',
      'trusted',
      'skipVerification',
      'override',
      'isReadyForSettlement',
    ];
    for (const prop of forbiddenCallerProps) {
      if (prop in input) {
        return {
          status: 'SETTLEMENT_REFUSED_PROOF_GATE',
          reason: `Production settlement gate refused: unauthorized caller property '${prop}' detected`,
        };
      }
    }

    const evidence = input.evidence;
    if (
      !evidence ||
      typeof evidence !== 'object' ||
      (evidence as { isReadyForSettlement?: unknown }).isReadyForSettlement !== true ||
      (Array.isArray(evidence.unresolvedFacts) && evidence.unresolvedFacts.length > 0)
    ) {
      return {
        status: 'SETTLEMENT_REFUSED_PROOF_GATE',
        reason:
          'Production settlement gate refused: authenticated renewal evidence lacks independent provider invoice cycle ownership proof (isReadyForSettlement: false)',
      };
    }

    return this.executeAtomicSettlementTransaction(input);
  }

  /**
   * Internal execution path for the atomic PostgreSQL renewal settlement transaction.
   * Protected to allow test suites to verify transaction boundaries, row locking,
   * monotonic sequence allocation, and invariant rollback in isolation.
   */
  protected async executeAtomicSettlementTransaction(
    input: RenewalSettlementInput
  ): Promise<RenewalSettlementResult> {
    // 1. Policy validation (fail-closed if unspecified or invalid)
    const policy = input.billingPolicy;
    if (
      policy !== RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING &&
      policy !== RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING
    ) {
      throw new PermanentWebhookError(`Unsupported or unspecified renewal billing policy: ${String(policy)}`);
    }

    // 2. Evidence Payload Validation
    const evidence = input.evidence;
    if (evidence.outcome !== 'AUTHENTICATED_EVIDENCE_PRODUCED') {
      throw new PermanentWebhookError(
        `Settlement requires AUTHENTICATED_EVIDENCE_PRODUCED; received outcome: ${evidence.outcome}`
      );
    }

    const webhookAssoc = evidence.webhookAssociation;
    if (!webhookAssoc) {
      throw new PermanentWebhookError('Evidence lacks required webhook association details');
    }

    const subProof = evidence.subscriptionProof;
    if (!subProof || subProof.status !== 'active') {
      throw new PermanentWebhookError('Evidence lacks verified active subscription proof');
    }

    const txProof = evidence.transactionProof;
    if (!txProof || txProof.status !== 'success') {
      throw new PermanentWebhookError('Evidence lacks verified successful transaction proof');
    }

    if (txProof.currency !== 'USD' || txProof.amountCents < 200) {
      throw new PermanentWebhookError('Verified transaction currency must be USD and meet minimum amount');
    }

    const subscriptionCode = subProof.subscriptionCode;
    const localSubscriptionId = subProof.localSubscriptionId;
    const invoiceCode = webhookAssoc.invoiceCode;
    const transactionReference = txProof.reference;
    const providerTransactionId = txProof.providerTransactionId;
    const amountCents = txProof.amountCents;

    // Determine trustworthy paid timestamp from verified webhook invoicePaidAt, or current time
    const rawPaidAt = webhookAssoc.invoicePaidAt ?? this.nowProvider();
    const paidAt = rawPaidAt instanceof Date && !Number.isNaN(rawPaidAt.getTime()) ? rawPaidAt : this.nowProvider();

    // 3. Atomic PostgreSQL Transaction Loop
    for (let retry = 1; retry <= TRANSACTION_RETRIES; retry += 1) {
      try {
        return await this.runFinancialTransaction(async (tx) => {
          // Step 1: Acquire exclusive row lock on parent subscription (Global Lock Level 1)
          await tx.$queryRaw`SELECT "id" FROM "BillingSubscription" WHERE "id" = ${localSubscriptionId} FOR UPDATE`;

          // Step 2: Reload fresh subscription state under lock
          const subscription = await tx.billingSubscription.findUnique({
            where: { id: localSubscriptionId },
            include: {
              currentPlan: true,
              currentPrice: true,
            },
          });

          if (!subscription) {
            throw new PermanentWebhookError('Billing subscription disappeared during settlement locking');
          }

          if (subscription.status === BillingSubscriptionStatus.CANCELED) {
            throw new PermanentWebhookError('Cannot settle renewal on a canceled subscription');
          }

          if (subscription.currency !== 'USD') {
            throw new PermanentWebhookError('Subscription currency must be USD');
          }

          if (subscription.providerSubscriptionId !== subscriptionCode) {
            throw new PermanentWebhookError(
              `Subscription provider code mismatch: stored ${subscription.providerSubscriptionId} vs verified ${subscriptionCode}`
            );
          }

          if (subscription.providerCustomerId !== subProof.providerCustomerId) {
            throw new PermanentWebhookError(
              `Subscription provider customer mismatch: stored ${subscription.providerCustomerId} vs verified ${subProof.providerCustomerId}`
            );
          }

          // Step 3: Re-evaluate Renewal Pairing under Lock
          const pairing = await evaluateRenewalPairing(tx, {
            localSubscriptionId: subscription.id,
            invoiceCode,
            providerTransactionId,
            providerReference: transactionReference,
          });

          if (pairing.status === 'CONFLICT') {
            throw new PermanentWebhookError(`Renewal settlement conflict: ${pairing.error}`);
          }

          if (pairing.status === 'INCOMPLETE') {
            throw new PermanentWebhookError(`Incomplete renewal state: ${pairing.error}`);
          }

          if (pairing.status === 'EXACT_REPLAY') {
            // Safe idempotent no-write success
            return {
              status: 'EXACT_REPLAY_ACKNOWLEDGED',
              invoiceId: pairing.invoiceId,
              paymentAttemptId: pairing.paymentAttemptId,
              reason: 'Exact replay of previously settled renewal cycle; zero records modified',
            };
          }

          // Step 4: Monotonic sequence allocation & chronological cycle calculation
          const latestPeriod = await tx.billingPeriod.findFirst({
            where: {
              subscriptionId: subscription.id,
              status: { not: BillingPeriodStatus.VOID },
            },
            orderBy: { sequence: 'desc' },
          });

          if (!latestPeriod) {
            throw new PermanentWebhookError('Subscription has no active or finalized initial period (sequence 1)');
          }

          // Obtain anchor strictly from sequence 1, never from mutable subscription dates
          const initialPeriod = await tx.billingPeriod.findFirst({
            where: {
              subscriptionId: subscription.id,
              sequence: 1,
            },
          });

          if (!initialPeriod) {
            throw new PermanentWebhookError('Subscription initial billing period (sequence 1) is missing');
          }

          const nextBoundaries = calculateNextBillingPeriod({
            policy,
            previousPeriod: {
              sequence: latestPeriod.sequence,
              startsAt: latestPeriod.startsAt,
              endsAt: latestPeriod.endsAt,
            },
            initialPeriod: {
              startsAt: initialPeriod.startsAt,
            },
          });

          // Step 5: Historical pricing and seat validation
          const price = subscription.currentPrice;
          const pricing = calculateHistoricalRenewalPricing(price, latestPeriod.billableStaffSeats);
          if (pricing.monthlyTotalCents !== amountCents) {
            throw new PermanentWebhookError(
              `Verified payment amount (${amountCents}) does not match expected historical renewal pricing (${pricing.monthlyTotalCents})`
            );
          }

          // Step 6: Persist period, invoice, payment attempt, ledger transaction atomically
          const period = await tx.billingPeriod.create({
            data: {
              subscriptionId: subscription.id,
              sequence: nextBoundaries.sequence,
              startsAt: nextBoundaries.startsAt,
              endsAt: nextBoundaries.endsAt,
              planCodeSnapshot: subscription.currentPlan.code,
              monthlyPriceCents: price.monthlyPriceCents,
              includedStaffSeats: price.includedStaffSeats,
              extraStaffSeatPriceCents: price.extraStaffSeatPriceCents,
              billableStaffSeats: pricing.billableStaffSeats,
              extraStaffSeats: pricing.extraStaffSeats,
              baseAmountCents: pricing.monthlyTotalCents - pricing.extraStaffAmountCents,
              extraSeatAmountCents: pricing.extraStaffAmountCents,
              totalAmountCents: amountCents,
              currency: 'USD',
              status: BillingPeriodStatus.FINALIZED,
            },
          });

          const invoice = await tx.billingInvoice.create({
            data: {
              subscriptionId: subscription.id,
              periodId: period.id,
              providerInvoiceId: invoiceCode,
              status: BillingInvoiceStatus.PAID,
              subtotalCents: amountCents,
              totalCents: amountCents,
              amountPaidCents: amountCents,
              currency: 'USD',
              paidAt,
            },
          });

          const attempt = await tx.billingPaymentAttempt.create({
            data: {
              invoiceId: invoice.id,
              providerReference: transactionReference,
              providerPaymentId: providerTransactionId,
              idempotencyKey: `paystack:renewal:${providerTransactionId}`,
              attemptNumber: 1,
              amountCents,
              status: BillingPaymentAttemptStatus.SUCCEEDED,
            },
          });

          // Ledger transaction and balanced entries
          const ledgerExternalReference = `paystack:payment:${providerTransactionId}`;
          const ledger = await tx.billingLedgerTransaction.create({
            data: {
              teamId: subscription.teamId,
              subscriptionId: subscription.id,
              invoiceId: invoice.id,
              externalReference: ledgerExternalReference,
              type: BillingLedgerTransactionType.PAYMENT,
              status: BillingLedgerTransactionStatus.DRAFT,
              currency: 'USD',
              totalDebitCents: amountCents,
              totalCreditCents: amountCents,
              description: 'Verified Paystack recurring subscription renewal',
              metadata: { provider: 'paystack', providerTransactionId },
              occurredAt: paidAt,
            },
          });

          await tx.billingLedgerEntry.createMany({
            data: [
              { transactionId: ledger.id, accountCode: CASH_ACCOUNT, debitCents: amountCents, creditCents: 0 },
              {
                transactionId: ledger.id,
                accountCode: ACCOUNTS_RECEIVABLE_ACCOUNT,
                debitCents: 0,
                creditCents: amountCents,
              },
            ],
          });

          await tx.billingLedgerTransaction.update({
            where: { id: ledger.id },
            data: { status: BillingLedgerTransactionStatus.POSTED, postedAt: paidAt },
          });

          // Step 7: Entitlement & Subscription Advancement
          // A payment for an expired historical cycle must not activate access for unpaid future cycles.
          const now = this.nowProvider();
          let newStatus = subscription.status;
          let nextPeriodEnd = nextBoundaries.endsAt;
          let gracePeriodEndsAt = subscription.gracePeriodEndsAt;

          if (nextBoundaries.endsAt <= now) {
            // Payment settled an expired historical cycle
            if (subscription.currentPeriodEnd && subscription.currentPeriodEnd > nextBoundaries.endsAt) {
              nextPeriodEnd = subscription.currentPeriodEnd;
            }
            if (subscription.status === BillingSubscriptionStatus.ACTIVE) {
              newStatus = BillingSubscriptionStatus.PAST_DUE;
            }
          } else {
            // Current or future cycle
            newStatus = BillingSubscriptionStatus.ACTIVE;
            gracePeriodEndsAt = null;
          }

          await tx.billingSubscription.update({
            where: { id: subscription.id },
            data: {
              status: newStatus,
              currentPeriodStart: nextBoundaries.startsAt,
              currentPeriodEnd: nextPeriodEnd,
              gracePeriodEndsAt,
              version: { increment: 1 },
            },
          });

          return {
            status: 'SETTLED',
            periodId: period.id,
            sequence: period.sequence,
            invoiceId: invoice.id,
            paymentAttemptId: attempt.id,
            ledgerTransactionId: ledger.id,
            subscriptionStatus: newStatus,
            currentPeriodStart: period.startsAt,
            currentPeriodEnd: nextPeriodEnd,
          };
        });
      } catch (error) {
        // Retryable PostgreSQL serialization or conflict errors
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P2028' || error.code === 'P2002') &&
          retry < TRANSACTION_RETRIES
        ) {
          await new Promise((resolve) => setTimeout(resolve, retry * 50));
          continue;
        }
        throw error;
      }
    }

    throw new RetryableWebhookError('Renewal settlement exceeded transaction retry limits');
  }

  private runFinancialTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (this.transactionRunner) return this.transactionRunner(operation);
    if ('$transaction' in this.database && typeof (this.database as PrismaClient).$transaction === 'function') {
      return (this.database as PrismaClient).$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 15_000,
      });
    }
    throw new PermanentWebhookError('Database client does not support transactions');
  }
}
