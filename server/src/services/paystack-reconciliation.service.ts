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
  PAYSTACK_CUSTOMER_CODE_PATTERN,
  PAYSTACK_PLAN_CODE_PATTERN,
  PAYSTACK_SUBSCRIPTION_CODE_PATTERN,
  PAYSTACK_USD_MINIMUM_CENTS,
  PaymentGatewayError,
  type PaystackCurrency,
  type PaymentGateway,
  type VerifiedPayment,
  type VerifiedSubscription,
} from '../billing/payments';
import { prisma as defaultPrisma } from '../database/prisma';
import { PermanentWebhookError, RetryableWebhookError, type WebhookEventProcessor } from '../jobs/webhook-event-processor';

const PAYSTACK_PROVIDER = 'paystack';
const CHARGE_SUCCESS_EVENT = 'charge.success';
const SUBSCRIPTION_CREATE_EVENT = 'subscription.create';
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
  recurring?: boolean;
  providerPlanCode?: string;
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

type SubscriptionCreateHint = {
  subscriptionCode: string;
  customerCode: string;
  planCode?: string;
  amountCents?: number;
};

const parseSubscriptionHint = (payload: unknown): SubscriptionCreateHint => {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new ReconciliationPermanentError('Supported Paystack event does not contain valid event data');
  }
  const data = payload.data;
  const rawSubCode = typeof data.subscription_code === 'string'
    ? data.subscription_code
    : (typeof data.subscriptionCode === 'string' ? data.subscriptionCode : undefined);

  if (!rawSubCode || !PAYSTACK_SUBSCRIPTION_CODE_PATTERN.test(rawSubCode)) {
    throw new ReconciliationPermanentError('Supported Paystack event does not contain a valid subscription code');
  }

  let rawCustomerCode: string | undefined;
  if (isRecord(data.customer) && typeof data.customer.customer_code === 'string') {
    rawCustomerCode = data.customer.customer_code;
  } else if (isRecord(data.customer) && typeof data.customer.customerCode === 'string') {
    rawCustomerCode = data.customer.customerCode;
  } else if (typeof data.customer_code === 'string') {
    rawCustomerCode = data.customer_code;
  } else if (typeof data.customerCode === 'string') {
    rawCustomerCode = data.customerCode;
  }

  if (!rawCustomerCode || !PAYSTACK_CUSTOMER_CODE_PATTERN.test(rawCustomerCode)) {
    throw new ReconciliationPermanentError('Supported Paystack event does not contain a valid customer code');
  }

  let rawPlanCode: string | undefined;
  if (isRecord(data.plan) && typeof data.plan.plan_code === 'string') {
    rawPlanCode = data.plan.plan_code;
  } else if (isRecord(data.plan) && typeof data.plan.planCode === 'string') {
    rawPlanCode = data.plan.planCode;
  } else if (typeof data.plan_code === 'string') {
    rawPlanCode = data.plan_code;
  } else if (typeof data.planCode === 'string') {
    rawPlanCode = data.planCode;
  }

  if (rawPlanCode !== undefined && !PAYSTACK_PLAN_CODE_PATTERN.test(rawPlanCode)) {
    throw new ReconciliationPermanentError('Supported Paystack event contains an invalid plan code hint');
  }

  const rawAmount = typeof data.amount === 'number' ? data.amount : undefined;
  if (rawAmount !== undefined && (!Number.isSafeInteger(rawAmount) || rawAmount < PAYSTACK_USD_MINIMUM_CENTS)) {
    throw new ReconciliationPermanentError('Supported Paystack event contains an invalid amount hint');
  }

  return {
    subscriptionCode: rawSubCode,
    customerCode: rawCustomerCode,
    planCode: rawPlanCode,
    amountCents: rawAmount,
  };
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
  const recurring = typeof value.recurring === 'boolean' ? value.recurring : undefined;
  let providerPlanCode: string | undefined;
  if (recurring) {
    if (typeof value.providerPlanCode !== 'string' || !PAYSTACK_PLAN_CODE_PATTERN.test(value.providerPlanCode)) {
      throw new ReconciliationPermanentError('Persisted recurring checkout metadata is missing a valid plan code');
    }
    providerPlanCode = value.providerPlanCode;
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
    ...(recurring ? { recurring: true, providerPlanCode } : {}),
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
  if (payment.providerCustomerId !== undefined) {
    if (typeof payment.providerCustomerId !== 'string'
      || !PAYSTACK_CUSTOMER_CODE_PATTERN.test(payment.providerCustomerId)) {
      throw new ReconciliationPermanentError('Provider customer identity has an invalid format');
    }
  }
};

const mapGatewayError = (error: PaymentGatewayError): Error => {
  if (error.code === 'TIMEOUT' || error.code === 'NETWORK' || error.code === 'PROVIDER_FAILURE') {
    return new RetryableWebhookError('Paystack payment verification is temporarily unavailable');
  }
  return new ReconciliationPermanentError('Paystack payment verification did not match the persisted payment operation');
};

const mapSubscriptionGatewayError = (error: PaymentGatewayError): Error => {
  if (error.code === 'TIMEOUT' || error.code === 'NETWORK' || error.code === 'PROVIDER_FAILURE') {
    return new RetryableWebhookError('Paystack subscription verification is temporarily unavailable');
  }
  return new ReconciliationPermanentError(`Paystack subscription verification did not match the persisted checkout: ${error.message}`);
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
    if (event.eventType === CHARGE_SUCCESS_EVENT) {
      await this.processChargeSuccess(event);
    } else if (event.eventType === SUBSCRIPTION_CREATE_EVENT) {
      await this.processSubscriptionCreate(event);
    }
  }

  private async processChargeSuccess(event: WebhookEvent): Promise<void> {
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

  private async processSubscriptionCreate(event: WebhookEvent): Promise<void> {
    const hint = parseSubscriptionHint(event.payload);

    const subscription = await this.database.billingSubscription.findUnique({
      where: { providerCustomerId: hint.customerCode },
      include: {
        currentPlan: true,
        currentPrice: true,
        team: true,
        invoices: {
          include: {
            paymentAttempts: {
              include: {
                idempotencyRecord: true,
              },
            },
          },
        },
      },
    });

    if (!subscription || !subscription.providerCustomerId) {
      throw new RetryableWebhookError('Provider customer identity has not yet been reconciled from payment');
    }

    if (subscription.currency !== 'USD') {
      throw new ReconciliationPermanentError('Subscription currency must be USD');
    }

    const matchingCheckouts: Array<{
      providerPlanCode: string;
      amountCents: number;
      operation: PersistedCheckout;
    }> = [];

    for (const invoice of subscription.invoices) {
      for (const attempt of invoice.paymentAttempts) {
        if (!attempt.idempotencyRecord?.responseBody) continue;
        try {
          const op = parsePersistedCheckout(attempt.idempotencyRecord.responseBody);
          if (op.recurring === true && op.providerPlanCode) {
            if (attempt.idempotencyRecord.teamId && attempt.idempotencyRecord.teamId !== subscription.teamId) {
              throw new ReconciliationPermanentError('Recurring checkout team mismatch');
            }
            if (op.subscriptionId !== subscription.id) {
              throw new ReconciliationPermanentError('Recurring checkout subscription mismatch');
            }
            if (op.currency !== 'USD' || invoice.currency !== 'USD') {
              throw new ReconciliationPermanentError('Recurring checkout currency must be USD');
            }
            matchingCheckouts.push({
              providerPlanCode: op.providerPlanCode,
              amountCents: op.amountCents,
              operation: op,
            });
          }
        } catch (error) {
          if (error instanceof ReconciliationPermanentError) throw error;
        }
      }
    }

    if (matchingCheckouts.length === 0) {
      throw new ReconciliationPermanentError('No matching recurring checkout found for subscription');
    }

    const distinctPlanCodes = new Set(matchingCheckouts.map((c) => c.providerPlanCode));
    const distinctAmounts = new Set(matchingCheckouts.map((c) => c.amountCents));

    if (distinctPlanCodes.size > 1 || distinctAmounts.size > 1) {
      throw new ReconciliationPermanentError('Ambiguous recurring checkout operations on subscription');
    }

    const checkout = matchingCheckouts[0];

    if (hint.planCode && hint.planCode !== checkout.providerPlanCode) {
      throw new ReconciliationPermanentError('Webhook plan code hint does not match recurring checkout');
    }
    if (hint.amountCents !== undefined && hint.amountCents !== checkout.amountCents) {
      throw new ReconciliationPermanentError('Webhook amount hint does not match recurring checkout');
    }

    let verified: VerifiedSubscription | null;
    try {
      verified = await this.gateway.fetchSubscriptionByCode({
        subscriptionCode: hint.subscriptionCode,
        expectedPlanCode: checkout.providerPlanCode,
        expectedCustomerCode: subscription.providerCustomerId,
        expectedAmountCents: checkout.amountCents,
        expectedCurrency: 'USD',
        expectedInterval: 'monthly',
      });
    } catch (error) {
      if (error instanceof PaymentGatewayError) {
        throw mapSubscriptionGatewayError(error);
      }
      throw error;
    }

    if (!verified) {
      throw new ReconciliationPermanentError('Provider subscription was not found on Paystack');
    }

    if (verified.subscriptionCode !== hint.subscriptionCode
      || verified.customerCode !== subscription.providerCustomerId
      || verified.planCode !== checkout.providerPlanCode
      || verified.amountCents !== checkout.amountCents
      || verified.currency !== 'USD'
      || verified.interval !== 'monthly'
      || verified.status !== 'active') {
      throw new ReconciliationPermanentError('Verified provider subscription does not match the expected recurring checkout');
    }

    await this.applySubscriptionLinkage(subscription.id, verified, checkout.operation);
  }

  private async applySubscriptionLinkage(
    subscriptionId: string,
    verified: VerifiedSubscription,
    operation: PersistedCheckout,
  ): Promise<void> {
    for (let retry = 1; retry <= TRANSACTION_RETRIES; retry += 1) {
      try {
        await this.runFinancialTransaction(async (transaction) => {
          await transaction.$queryRaw`SELECT "id" FROM "BillingSubscription" WHERE "id" = ${subscriptionId} FOR UPDATE`;

          const current = await transaction.billingSubscription.findUnique({
            where: { id: subscriptionId },
          });
          if (!current) {
            throw new ReconciliationPermanentError('Billing subscription disappeared during linkage');
          }

          if (current.providerCustomerId !== verified.customerCode) {
            throw new ReconciliationPermanentError('Subscription customer identity mismatch during linkage');
          }

          if (current.providerSubscriptionId === verified.subscriptionCode) {
            if (current.status === BillingSubscriptionStatus.PENDING_CHECKOUT) {
              await this.activateSubscriptionIfEligible(transaction, current.id, operation);
            }
            return;
          }

          if (current.providerSubscriptionId !== null) {
            throw new ReconciliationPermanentError(
              `Subscription is already linked to a different provider subscription: ${current.providerSubscriptionId}`
            );
          }

          const existingWithProviderSub = await transaction.billingSubscription.findUnique({
            where: { providerSubscriptionId: verified.subscriptionCode },
          });
          if (existingWithProviderSub && existingWithProviderSub.id !== current.id) {
            throw new ReconciliationPermanentError(
              'Provider subscription is already linked to another team'
            );
          }

          await transaction.billingSubscription.update({
            where: { id: current.id },
            data: {
              providerSubscriptionId: verified.subscriptionCode,
              version: { increment: 1 },
            },
          });

          await this.activateSubscriptionIfEligible(transaction, current.id, operation);
        });
        return;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2028') && retry < TRANSACTION_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, retry * 50));
          continue;
        }
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ReconciliationPermanentError('Provider subscription is already linked to another team');
        }
        throw error;
      }
    }
  }

  private async activateSubscriptionIfEligible(
    transaction: Prisma.TransactionClient,
    subscriptionId: string,
    operation: PersistedCheckout,
  ): Promise<boolean> {
    const subscription = await transaction.billingSubscription.findUnique({
      where: { id: subscriptionId },
      include: {
        currentPlan: true,
        currentPrice: true,
      },
    });
    if (!subscription) return false;
    if (subscription.status === BillingSubscriptionStatus.ACTIVE) return true;

    if (operation.recurring) {
      if (!subscription.providerSubscriptionId || !subscription.providerCustomerId) {
        return false;
      }
    }

    const attempt = await transaction.billingPaymentAttempt.findFirst({
      where: {
        invoice: { subscriptionId: subscription.id },
        status: BillingPaymentAttemptStatus.SUCCEEDED,
      },
      include: {
        invoice: true,
        idempotencyRecord: true,
      },
      orderBy: { attemptNumber: 'asc' },
    });
    if (!attempt || attempt.invoice.status !== BillingInvoiceStatus.PAID || !attempt.providerPaymentId) {
      return false;
    }

    const externalReference = `paystack:payment:${attempt.providerPaymentId}`;
    const ledger = await transaction.billingLedgerTransaction.findUnique({
      where: { externalReference },
    });
    if (!ledger || ledger.status !== BillingLedgerTransactionStatus.POSTED) {
      return false;
    }

    if (subscription.currentPlan.code !== operation.planCode) {
      throw new ReconciliationPermanentError('Subscription plan does not match the persisted checkout plan');
    }
    if (subscription.currency !== 'USD' || attempt.invoice.currency !== 'USD' || operation.currency !== 'USD') {
      throw new ReconciliationPermanentError('Subscription currency must be USD');
    }

    const price = subscription.currentPrice;
    const pricing = calculateHistoricalPricing(price, operation.billableStaffSeats);
    if (pricing.monthlyTotalCents !== attempt.amountCents || pricing.monthlyTotalCents !== operation.amountCents) {
      throw new ReconciliationPermanentError('Persisted billing amount does not match the payment attempt');
    }

    let period = await transaction.billingPeriod.findFirst({
      where: { subscriptionId: subscription.id },
    });
    const periodStart = attempt.invoice.paidAt ?? new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const periodEnd = addOneCalendarMonth(periodStart);

    if (!period) {
      period = await transaction.billingPeriod.create({
        data: {
          subscriptionId: subscription.id,
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
    }

    if (attempt.invoice.periodId !== period.id) {
      await transaction.billingInvoice.update({
        where: { id: attempt.invoiceId },
        data: { periodId: period.id },
      });
    }

    await transaction.billingSubscription.update({
      where: { id: subscription.id },
      data: {
        status: BillingSubscriptionStatus.ACTIVE,
        currentPeriodStart: period.startsAt,
        currentPeriodEnd: period.endsAt,
        version: { increment: 1 },
      },
    });

    return true;
  }

  private async applyFinancialState(
    initialAttempt: PaymentAttemptWithContext,
    operation: PersistedCheckout,
    verified: VerifiedPayment,
  ): Promise<void> {
    for (let retry = 1; retry <= TRANSACTION_RETRIES; retry += 1) {
      try {
        await this.runFinancialTransaction(async (transaction) => {
          await transaction.$queryRaw`SELECT "id" FROM "BillingSubscription" WHERE "id" = ${initialAttempt.invoice.subscriptionId} FOR UPDATE`;
          await transaction.$queryRaw`SELECT "id" FROM "BillingInvoice" WHERE "id" = ${initialAttempt.invoiceId} FOR UPDATE`;
          await transaction.$queryRaw`SELECT "id" FROM "BillingPaymentAttempt" WHERE "id" = ${initialAttempt.id} FOR UPDATE`;

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
            const validSubscriptionStatus = !operation.recurring
              ? attempt.invoice.subscription.status === BillingSubscriptionStatus.ACTIVE
              : attempt.invoice.subscription.providerSubscriptionId !== null
                ? (attempt.invoice.subscription.status === BillingSubscriptionStatus.ACTIVE
                  || attempt.invoice.subscription.status === BillingSubscriptionStatus.PENDING_CHECKOUT)
                : attempt.invoice.subscription.status === BillingSubscriptionStatus.PENDING_CHECKOUT;

            if (attempt.providerPaymentId !== verified.providerTransactionId
              || attempt.invoice.status !== BillingInvoiceStatus.PAID
              || attempt.invoice.amountPaidCents !== attempt.amountCents
              || !validSubscriptionStatus
              || (attempt.invoice.subscription.providerCustomerId ?? undefined) !== verified.providerCustomerId
              || !existingLedger
              || existingLedger.status !== BillingLedgerTransactionStatus.POSTED) {
              throw new ReconciliationPermanentError('Existing successful payment state does not match the verified transaction');
            }

            if (operation.recurring
              && attempt.invoice.subscription.providerSubscriptionId !== null
              && attempt.invoice.subscription.status === BillingSubscriptionStatus.PENDING_CHECKOUT) {
              await this.activateSubscriptionIfEligible(transaction, attempt.invoice.subscriptionId, operation);
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

          if (attempt.invoice.subscription.providerCustomerId !== null
            && attempt.invoice.subscription.providerCustomerId !== verified.providerCustomerId) {
            throw new ReconciliationPermanentError('Subscription is already associated with a different provider customer');
          }

          if (verified.providerCustomerId) {
            const customerOwner = await transaction.billingSubscription.findUnique({
              where: { providerCustomerId: verified.providerCustomerId },
            });
            if (customerOwner && customerOwner.id !== attempt.invoice.subscriptionId) {
              throw new ReconciliationPermanentError('Provider customer identity is already associated with another subscription');
            }
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

          await transaction.billingPaymentAttempt.update({
            where: { id: attempt.id },
            data: { status: BillingPaymentAttemptStatus.SUCCEEDED, providerPaymentId: verified.providerTransactionId },
          });
          await transaction.billingInvoice.update({
            where: { id: attempt.invoiceId },
            data: { status: BillingInvoiceStatus.PAID, amountPaidCents: attempt.amountCents, paidAt: periodStart },
          });
          await transaction.billingSubscription.update({
            where: { id: attempt.invoice.subscriptionId },
            data: {
              provider: PAYSTACK_PROVIDER,
              providerCustomerId: attempt.invoice.subscription.providerCustomerId ?? verified.providerCustomerId ?? null,
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

          const canActivate = !operation.recurring || attempt.invoice.subscription.providerSubscriptionId !== null;
          if (canActivate) {
            await this.activateSubscriptionIfEligible(transaction, attempt.invoice.subscriptionId, operation);
          }
        });
        return;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2034' || error.code === 'P2028') && retry < TRANSACTION_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, retry * 50));
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
      maxWait: 10_000,
      timeout: 15_000,
    });
  }
}
