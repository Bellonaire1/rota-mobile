import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingLedgerTransactionType,
  BillingPaymentAttemptStatus,
  BillingSubscriptionStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import type { BillingPlanCode as PricingPlanCode } from '../billing/pricing';
import {
  PaymentGatewayError,
  type PaystackCurrency,
  type PaymentGateway,
  type VerifiedPayment,
} from '../billing/payments';
import { prisma as defaultPrisma } from '../database/prisma';
import { PermanentWebhookError, RetryableWebhookError, type WebhookEventProcessor } from '../jobs/webhook-event-processor';

const PAYSTACK_PROVIDER = 'paystack';
const SUPPORTED_EVENT_TYPE = 'charge.success';
const CASH_ACCOUNT = 'cash';
const ACCOUNTS_RECEIVABLE_ACCOUNT = 'accounts_receivable';
const TRANSACTION_RETRIES = 5;

type WebhookEvent = { id: string; provider: string; eventType: string; payload: unknown };

export type ReconciliationDatabase = PrismaClient | Prisma.TransactionClient;
export type ReconciliationTransactionRunner = <T>(
  operation: (transaction: Prisma.TransactionClient) => Promise<T>
) => Promise<T>;

type PersistedCheckout = {
  subscriptionId: string;
  invoiceId: string;
  paymentAttemptId: string;
  providerReference: string;
  planCode: PricingPlanCode;
  priceId: string;
  billableStaffSeats: number;
  amountCents: number;
  currency: 'USD';
};

type PaymentAttemptWithContext = Prisma.BillingPaymentAttemptGetPayload<{
  include: {
    invoice: {
      include: {
        subscription: { include: { currentPlan: true; currentPrice: true } };
      };
    };
    idempotencyRecord: true;
  };
}>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const parseReferenceHint = (payload: unknown): string => {
  if (!isRecord(payload) || !isRecord(payload.data) || typeof payload.data.reference !== 'string') {
    throw new ReconciliationPermanentError('Supported Paystack event does not contain a payment reference');
  }
  return payload.data.reference;
};

const parsePersistedCheckout = (value: Prisma.JsonValue | null): PersistedCheckout => {
  const billableStaffSeats = isRecord(value) ? value.billableStaffSeats : undefined;
  const amountCents = isRecord(value) ? value.amountCents : undefined;
  if (!isRecord(value)
    || typeof value.subscriptionId !== 'string'
    || typeof value.invoiceId !== 'string'
    || typeof value.paymentAttemptId !== 'string'
    || typeof value.providerReference !== 'string'
    || typeof value.priceId !== 'string'
    || !['STARTER', 'TEAM', 'BUSINESS'].includes(String(value.planCode))
    || !Number.isSafeInteger(billableStaffSeats)
    || !Number.isSafeInteger(amountCents)
    || value.currency !== 'USD') {
    throw new ReconciliationPermanentError('Persisted checkout metadata is incomplete');
  }
  return {
    subscriptionId: value.subscriptionId,
    invoiceId: value.invoiceId,
    paymentAttemptId: value.paymentAttemptId,
    providerReference: value.providerReference,
    planCode: value.planCode as PricingPlanCode,
    priceId: value.priceId,
    billableStaffSeats: billableStaffSeats as number,
    amountCents: amountCents as number,
    currency: 'USD',
  };
};

const addOneCalendarMonth = (start: Date): Date => {
  const end = new Date(start);
  const day = end.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
};

const assertVerifiedPayment = (payment: VerifiedPayment, expected: {
  reference: string;
  amountCents: number;
  currency: PaystackCurrency;
}): void => {
  if (payment.status !== 'success'
    || payment.reference !== expected.reference
    || payment.amountCents !== expected.amountCents
    || payment.currency !== expected.currency
    || !payment.providerTransactionId
    || !/^[A-Za-z0-9._:-]{1,200}$/.test(payment.providerTransactionId)) {
    throw new ReconciliationPermanentError('Provider verification did not match the persisted payment operation');
  }
};

const mapGatewayError = (error: PaymentGatewayError): Error => {
  if (error.code === 'TIMEOUT' || error.code === 'NETWORK' || error.code === 'PROVIDER_FAILURE') {
    return new RetryableWebhookError('Paystack payment verification is temporarily unavailable');
  }
  return new ReconciliationPermanentError('Paystack payment verification did not match the persisted payment operation');
};

type HistoricalPrice = {
  id: string;
  planId: string;
  monthlyPriceCents: number;
  includedStaffSeats: number;
  extraStaffSeatPriceCents: number;
  currency: string;
};

type HistoricalPricing = {
  billableStaffSeats: number;
  extraStaffSeats: number;
  extraStaffAmountCents: number;
  monthlyTotalCents: number;
};

const calculateHistoricalPricing = (price: HistoricalPrice, billableStaffSeats: number): HistoricalPricing => {
  if (price.currency !== 'USD'
    || !Number.isSafeInteger(price.monthlyPriceCents)
    || price.monthlyPriceCents < 0
    || !Number.isSafeInteger(price.includedStaffSeats)
    || price.includedStaffSeats < 0
    || !Number.isSafeInteger(price.extraStaffSeatPriceCents)
    || price.extraStaffSeatPriceCents < 0
    || !Number.isSafeInteger(billableStaffSeats)
    || billableStaffSeats < 0) {
    throw new ReconciliationPermanentError('Persisted billing price or seat snapshot is invalid');
  }

  const extraStaffSeats = Math.max(0, billableStaffSeats - price.includedStaffSeats);
  if (price.extraStaffSeatPriceCents === 0 && extraStaffSeats > 0) {
    throw new ReconciliationPermanentError('Persisted billing seat snapshot exceeds its historical plan allowance');
  }
  const extraStaffAmountCents = extraStaffSeats * price.extraStaffSeatPriceCents;
  const monthlyTotalCents = price.monthlyPriceCents + extraStaffAmountCents;
  if (!Number.isSafeInteger(extraStaffAmountCents) || !Number.isSafeInteger(monthlyTotalCents)) {
    throw new ReconciliationPermanentError('Persisted billing price exceeds safe monetary limits');
  }
  return { billableStaffSeats, extraStaffSeats, extraStaffAmountCents, monthlyTotalCents };
};

export class ReconciliationPermanentError extends PermanentWebhookError {}

export class PaystackReconciliationProcessor implements WebhookEventProcessor {
  constructor(
    private readonly database: ReconciliationDatabase = defaultPrisma,
    private readonly gateway: PaymentGateway,
    private readonly transactionRunner?: ReconciliationTransactionRunner,
  ) {}

  async process(event: WebhookEvent): Promise<void> {
    if (event.provider !== PAYSTACK_PROVIDER) return;
    if (event.eventType !== SUPPORTED_EVENT_TYPE) return;

    const reference = parseReferenceHint(event.payload);
    const attempt = await this.database.billingPaymentAttempt.findUnique({
      where: { providerReference: reference },
      include: {
        invoice: { include: { subscription: { include: { currentPlan: true, currentPrice: true } } } },
        idempotencyRecord: true,
      },
    });
    if (!attempt) throw new ReconciliationPermanentError('No persisted payment attempt matches the provider reference');

    const operation = parsePersistedCheckout(attempt.idempotencyRecord?.responseBody ?? null);
    if (operation.paymentAttemptId !== attempt.id
      || operation.invoiceId !== attempt.invoiceId
      || operation.subscriptionId !== attempt.invoice.subscriptionId
      || operation.providerReference !== reference
      || operation.planCode !== attempt.invoice.subscription.currentPlan.code
      || operation.priceId !== attempt.invoice.subscription.currentPrice.id
      || operation.amountCents !== attempt.amountCents
      || operation.currency !== attempt.invoice.currency
      || attempt.invoice.currency !== 'USD') {
      throw new ReconciliationPermanentError('Persisted payment operation does not match its billing records');
    }

    let verified: VerifiedPayment;
    try {
      verified = await this.gateway.verifyTransaction({
        reference,
        expectedAmountCents: attempt.amountCents,
        expectedCurrency: attempt.invoice.currency as PaystackCurrency,
        expectedMetadata: { mode: 'test', subscriptionId: attempt.invoice.subscriptionId },
      });
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw mapGatewayError(error);
      throw error;
    }
    assertVerifiedPayment(verified, {
      reference,
      amountCents: attempt.amountCents,
      currency: attempt.invoice.currency as PaystackCurrency,
    });

    await this.applyFinancialState(attempt, operation, verified);
  }

  private async applyFinancialState(
    initialAttempt: PaymentAttemptWithContext,
    operation: PersistedCheckout,
    verified: VerifiedPayment,
  ): Promise<void> {
    for (let retry = 1; retry <= TRANSACTION_RETRIES; retry += 1) {
      try {
        await this.runFinancialTransaction(async (transaction) => {
          await transaction.$queryRaw`SELECT "id" FROM "BillingPaymentAttempt" WHERE "id" = ${initialAttempt.id} FOR UPDATE`;
          await transaction.$queryRaw`SELECT "id" FROM "BillingInvoice" WHERE "id" = ${initialAttempt.invoiceId} FOR UPDATE`;
          await transaction.$queryRaw`SELECT "id" FROM "BillingSubscription" WHERE "id" = ${initialAttempt.invoice.subscriptionId} FOR UPDATE`;

          const attempt = await transaction.billingPaymentAttempt.findUnique({
            where: { id: initialAttempt.id },
            include: {
              invoice: { include: { subscription: { include: { currentPlan: true, currentPrice: true } } } },
            },
          });
          if (!attempt) throw new ReconciliationPermanentError('Payment attempt disappeared during reconciliation');

          const providerOwner = await transaction.billingPaymentAttempt.findUnique({ where: { providerPaymentId: verified.providerTransactionId } });
          if (providerOwner && providerOwner.id !== attempt.id) {
            throw new ReconciliationPermanentError('Provider transaction is already linked to another payment attempt');
          }

          const externalReference = `paystack:payment:${verified.providerTransactionId}`;
          const existingLedger = await transaction.billingLedgerTransaction.findUnique({ where: { externalReference } });

          if (attempt.status === BillingPaymentAttemptStatus.SUCCEEDED) {
            if (attempt.providerPaymentId !== verified.providerTransactionId
              || attempt.invoice.status !== BillingInvoiceStatus.PAID
              || attempt.invoice.amountPaidCents !== attempt.amountCents
              || attempt.invoice.subscription.status !== BillingSubscriptionStatus.ACTIVE
              || !existingLedger
              || existingLedger.status !== BillingLedgerTransactionStatus.POSTED) {
              throw new ReconciliationPermanentError('Existing successful payment state does not match the verified transaction');
            }
            return;
          }

          if (attempt.status !== BillingPaymentAttemptStatus.PENDING
            || attempt.invoice.status !== BillingInvoiceStatus.DRAFT
            || attempt.invoice.amountPaidCents !== 0
            || attempt.invoice.subscription.status !== BillingSubscriptionStatus.PENDING_CHECKOUT
            || existingLedger) {
            throw new ReconciliationPermanentError('Payment is not in a reconciliable pending state');
          }

          const subscription = attempt.invoice.subscription;
          const price = subscription.currentPrice;
          if (operation.planCode !== subscription.currentPlan.code
            || operation.priceId !== price.id
            || price.planId !== subscription.currentPlan.id
            || subscription.currency !== 'USD'
            || attempt.invoice.currency !== 'USD'
            || attempt.amountCents !== attempt.invoice.subtotalCents
            || attempt.amountCents !== attempt.invoice.totalCents
            || operation.amountCents !== attempt.invoice.totalCents
            || verified.reference !== operation.providerReference
            || verified.amountCents !== attempt.amountCents
            || verified.currency !== attempt.invoice.currency) {
            throw new ReconciliationPermanentError('Historical checkout pricing does not match its billing records');
          }

          const pricing = calculateHistoricalPricing(price, operation.billableStaffSeats);
          if (pricing.monthlyTotalCents !== attempt.amountCents || pricing.monthlyTotalCents !== operation.amountCents) {
            throw new ReconciliationPermanentError('Persisted billing amount does not match the payment attempt');
          }

          const periodStart = new Date(Math.floor(Date.now() / 1_000) * 1_000);
          const periodEnd = addOneCalendarMonth(periodStart);
          const period = await transaction.billingPeriod.create({
            data: {
              subscriptionId: attempt.invoice.subscriptionId,
              sequence: 1,
              startsAt: periodStart,
              endsAt: periodEnd,
               planCodeSnapshot: operation.planCode,
               monthlyPriceCents: price.monthlyPriceCents,
               includedStaffSeats: price.includedStaffSeats,
               extraStaffSeatPriceCents: price.extraStaffSeatPriceCents,
               billableStaffSeats: pricing.billableStaffSeats,
              extraStaffSeats: pricing.extraStaffSeats,
              baseAmountCents: pricing.monthlyTotalCents - pricing.extraStaffAmountCents,
              extraSeatAmountCents: pricing.extraStaffAmountCents,
              totalAmountCents: attempt.amountCents,
              currency: 'USD',
            },
          });

          await transaction.billingPaymentAttempt.update({
            where: { id: attempt.id },
            data: { status: BillingPaymentAttemptStatus.SUCCEEDED, providerPaymentId: verified.providerTransactionId },
          });
          await transaction.billingInvoice.update({
            where: { id: attempt.invoiceId },
            data: { status: BillingInvoiceStatus.PAID, amountPaidCents: attempt.amountCents, paidAt: periodStart, periodId: period.id },
          });
          await transaction.billingSubscription.update({
            where: { id: attempt.invoice.subscriptionId },
            data: {
              status: BillingSubscriptionStatus.ACTIVE,
              provider: PAYSTACK_PROVIDER,
              currentPeriodStart: periodStart,
              currentPeriodEnd: periodEnd,
              version: { increment: 1 },
            },
          });

          const ledger = await transaction.billingLedgerTransaction.create({
            data: {
              teamId: attempt.invoice.subscription.teamId,
              subscriptionId: attempt.invoice.subscriptionId,
              invoiceId: attempt.invoiceId,
              externalReference,
              type: BillingLedgerTransactionType.PAYMENT,
              status: BillingLedgerTransactionStatus.DRAFT,
              currency: 'USD',
              totalDebitCents: attempt.amountCents,
              totalCreditCents: attempt.amountCents,
              description: 'Verified Paystack subscription payment',
              metadata: { provider: PAYSTACK_PROVIDER, providerTransactionId: verified.providerTransactionId },
              occurredAt: periodStart,
            },
          });
          await transaction.billingLedgerEntry.createMany({
            data: [
              { transactionId: ledger.id, accountCode: CASH_ACCOUNT, debitCents: attempt.amountCents, creditCents: 0 },
              { transactionId: ledger.id, accountCode: ACCOUNTS_RECEIVABLE_ACCOUNT, debitCents: 0, creditCents: attempt.amountCents },
            ],
          });
          await transaction.billingLedgerTransaction.update({
            where: { id: ledger.id },
            data: { status: BillingLedgerTransactionStatus.POSTED, postedAt: periodStart },
          });
        });
        return;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && retry < TRANSACTION_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, retry * 25));
          continue;
        }
        throw error;
      }
    }
  }

  private runFinancialTransaction<T>(operation: (transaction: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (this.transactionRunner) return this.transactionRunner(operation);
    return (this.database as PrismaClient).$transaction(operation, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }
}
