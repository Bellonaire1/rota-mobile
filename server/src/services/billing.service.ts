import { createHash, randomUUID } from 'node:crypto';
import {
  BillingIdempotencyStatus,
  BillingInvoiceStatus,
  BillingPaymentAttemptStatus,
  BillingPlanCode,
  BillingSubscriptionStatus,
  Prisma,
  TeamRole,
} from '@prisma/client';
import { prisma as defaultPrisma } from '../database/prisma';
import { runSerializable } from '../database/transactions';
import { AppError } from '../errors/AppError';
import {
  calculateSeatPricing,
  getPlan,
  PLAN_CATALOG,
  type BillingPlanCode as PricingPlanCode,
} from '../billing/pricing';
import {
  MockPaystackGateway,
  PAYSTACK_USD_MINIMUM_CENTS,
  PaymentGatewayError,
  type PaymentGateway,
} from '../billing/payments';
import type { CheckoutInput } from '../schemas/billing.schema';

const CHECKOUT_SCOPE = 'team-billing-checkout';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_RESERVATION_ATTEMPTS = 3;

type JsonRecord = Record<string, unknown>;

interface PersistedCheckout {
  state: 'RESERVED' | 'CHECKOUT_PENDING' | 'RECOVERY_REQUIRED' | 'FAILED';
  subscriptionId: string;
  invoiceId: string;
  paymentAttemptId: string;
  providerReference: string;
  planCode: BillingPlanCode;
  priceId: string;
  billableStaffSeats: number;
  amountCents: number;
  currency: 'USD';
  authorizationUrl?: string;
  accessCode?: string;
  failureCode?: string;
}

export interface CheckoutResponse extends PersistedCheckout {
  statusCode: 202 | 502;
  recoveryRequired: boolean;
}

const isPersistedCheckout = (value: unknown): value is PersistedCheckout => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as JsonRecord;
  return typeof candidate.state === 'string'
    && typeof candidate.subscriptionId === 'string'
    && typeof candidate.invoiceId === 'string'
    && typeof candidate.paymentAttemptId === 'string'
    && typeof candidate.providerReference === 'string'
    && typeof candidate.planCode === 'string'
    && typeof candidate.priceId === 'string'
    && Number.isSafeInteger(candidate.billableStaffSeats)
    && (candidate.billableStaffSeats as number) >= 0
    && typeof candidate.amountCents === 'number'
    && candidate.currency === 'USD';
};

const toCheckoutResponse = (operation: PersistedCheckout): CheckoutResponse => ({
  ...operation,
  statusCode: operation.state === 'FAILED' ? 502 : 202,
  recoveryRequired: operation.state === 'RECOVERY_REQUIRED' || operation.state === 'RESERVED',
});

const asJson = (operation: PersistedCheckout): Prisma.InputJsonValue =>
  operation as unknown as Prisma.InputJsonValue;

const canonicalClientRequest = (input: {
  teamId: string;
  ownerId: string;
  planCode: BillingPlanCode;
}): string => JSON.stringify({
  ownerId: input.ownerId,
  planCode: input.planCode,
  teamId: input.teamId,
  version: 1,
});

const requestHash = (canonical: string): string => createHash('sha256').update(canonical).digest('hex');

const assertIdempotencyKey = (value: string | undefined): string => {
  if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new AppError(400, 'A valid Idempotency-Key header is required');
  }
  return value;
};

const assertOwner = async (
  transaction: Prisma.TransactionClient,
  teamId: string,
  ownerId: string
): Promise<void> => {
  const membership = await transaction.teamMembership.findUnique({
    where: { teamId_userId: { teamId, userId: ownerId } },
    select: { role: true },
  });
  if (!membership) throw new AppError(404, 'Team not found');
  if (membership.role !== TeamRole.OWNER) throw new AppError(403, 'Insufficient team permissions');
};

const getActivePlan = async (
  transaction: Prisma.TransactionClient,
  planCode: BillingPlanCode
) => {
  const plan = await transaction.billingPlan.findFirst({
    where: { code: planCode, active: true },
    include: {
      prices: {
        where: { effectiveTo: null },
        orderBy: { effectiveFrom: 'desc' },
        take: 1,
      },
    },
  });
  const price = plan?.prices[0];
  if (!plan || !price || price.currency !== 'USD') {
    throw new AppError(409, 'The selected billing plan is unavailable');
  }
  const official = getPlan(planCode as PricingPlanCode);
  if (price.monthlyPriceCents !== official.monthlyPriceCents
    || price.includedStaffSeats !== official.includedStaffSeats
    || price.extraStaffSeatPriceCents !== official.extraStaffSeatPriceCents) {
    throw new AppError(409, 'The selected billing plan is unavailable');
  }
  return { plan, price };
};

const operationFromRecord = (record: Prisma.JsonValue): PersistedCheckout => {
  if (!isPersistedCheckout(record)) throw new AppError(503, 'Checkout operation requires recovery');
  return record;
};

export class BillingService {
  constructor(
    private readonly database: typeof defaultPrisma = defaultPrisma,
    private readonly gateway: PaymentGateway = new MockPaystackGateway()
  ) {}

  async listPlans() {
    const plans = await this.database.billingPlan.findMany({
      where: { active: true },
      include: { prices: { where: { effectiveTo: null }, orderBy: { effectiveFrom: 'desc' }, take: 1 } },
      orderBy: { code: 'asc' },
    });
    return plans.flatMap((plan) => {
      const price = plan.prices[0];
      if (!price || price.currency !== 'USD') return [];
      const official = PLAN_CATALOG[plan.code as PricingPlanCode];
      if (!official || price.monthlyPriceCents !== official.monthlyPriceCents
        || price.includedStaffSeats !== official.includedStaffSeats
        || price.extraStaffSeatPriceCents !== official.extraStaffSeatPriceCents) return [];
      return [{
        code: plan.code,
        displayName: plan.displayName,
        currency: 'USD' as const,
        monthlyPriceCents: price.monthlyPriceCents,
        includedStaffSeats: price.includedStaffSeats,
        extraStaffSeatPriceCents: price.extraStaffSeatPriceCents,
      }];
    });
  }

  async getTeamBilling(teamId: string, ownerId: string) {
    const membership = await this.database.teamMembership.findUnique({
      where: { teamId_userId: { teamId, userId: ownerId } },
      select: { role: true },
    });
    if (!membership) throw new AppError(404, 'Team not found');
    if (membership.role !== TeamRole.OWNER) throw new AppError(403, 'Insufficient team permissions');

    const subscription = await this.database.billingSubscription.findUnique({
      where: { teamId },
      include: {
        currentPlan: true,
        currentPrice: true,
        invoices: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            id: true,
            status: true,
            subtotalCents: true,
            totalCents: true,
            amountPaidCents: true,
            currency: true,
            createdAt: true,
            paymentAttempts: { select: { status: true, createdAt: true } },
          },
        },
      },
    });
    return {
      teamId,
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        planCode: subscription.currentPlan.code,
        currency: subscription.currency,
        latestInvoice: subscription.invoices[0] ?? null,
      } : null,
    };
  }

  async checkout(teamId: string, ownerId: string, input: CheckoutInput, headerKey: string | undefined): Promise<CheckoutResponse> {
    const key = assertIdempotencyKey(headerKey);
    const planCode = input.planCode as BillingPlanCode;
    let reserved: PersistedCheckout;
    let idempotencyId: string;
    let customerEmail: string;
    for (let attempt = 1; attempt <= MAX_RESERVATION_ATTEMPTS; attempt += 1) {
      try {
        const reservation = await runSerializable(async (transaction) => {
          await assertOwner(transaction, teamId, ownerId);
          const existing = await transaction.billingIdempotencyKey.findUnique({ where: { scope_key: { scope: `${CHECKOUT_SCOPE}:${teamId}`, key } } });
          if (existing) {
            if (existing.requestHash !== requestHash(canonicalClientRequest({ teamId, ownerId, planCode }))) {
              throw new AppError(409, 'Idempotency key was used with different checkout parameters');
            }
            return { existing: true, response: toCheckoutResponse(operationFromRecord(existing.responseBody)), idempotencyId: existing.id, customerEmail: '' };
          }
          const { plan, price } = await getActivePlan(transaction, planCode);
          const billableStaffSeats = await transaction.teamMembership.count({ where: { teamId, role: { in: [TeamRole.STAFF, TeamRole.MANAGER] } } });
          const seatPricing = calculateSeatPricing(planCode as PricingPlanCode, billableStaffSeats);
          if (seatPricing.monthlyTotalCents < PAYSTACK_USD_MINIMUM_CENTS) {
            throw new AppError(409, 'This checkout is below the Paystack USD minimum and is deferred');
          }
          const canonical = canonicalClientRequest({ teamId, ownerId, planCode });
          const hash = requestHash(canonical);
          const currentSubscription = await transaction.billingSubscription.findUnique({ where: { teamId }, select: { status: true } });
          if (currentSubscription) throw new AppError(409, 'Team already has a billing subscription');
          const owner = await transaction.user.findUniqueOrThrow({ where: { id: ownerId }, select: { email: true } });
          const providerReference = `rota-${teamId}-${randomUUID()}`;
          const subscription = await transaction.billingSubscription.create({ data: { teamId, planId: plan.id, priceId: price.id, status: BillingSubscriptionStatus.PENDING_CHECKOUT, currency: 'USD' } });
          const invoice = await transaction.billingInvoice.create({ data: { subscriptionId: subscription.id, subtotalCents: seatPricing.monthlyTotalCents, totalCents: seatPricing.monthlyTotalCents, currency: 'USD' } });
          const idempotency = await transaction.billingIdempotencyKey.create({ data: { scope: `${CHECKOUT_SCOPE}:${teamId}`, key, requestHash: hash, status: BillingIdempotencyStatus.IN_PROGRESS, teamId, userId: ownerId, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
          const paymentAttempt = await transaction.billingPaymentAttempt.create({ data: { invoiceId: invoice.id, providerReference, idempotencyKey: `${CHECKOUT_SCOPE}:${teamId}:${key}`, idempotencyKeyId: idempotency.id, attemptNumber: 1, amountCents: seatPricing.monthlyTotalCents, status: BillingPaymentAttemptStatus.PENDING } });
          const operation: PersistedCheckout = { state: 'RESERVED', subscriptionId: subscription.id, invoiceId: invoice.id, paymentAttemptId: paymentAttempt.id, providerReference, planCode, priceId: price.id, billableStaffSeats, amountCents: seatPricing.monthlyTotalCents, currency: 'USD' };
          await transaction.billingIdempotencyKey.update({ where: { id: idempotency.id }, data: { responseBody: asJson(operation) } });
          return { existing: false, response: toCheckoutResponse(operation), idempotencyId: idempotency.id, customerEmail: owner.email };
        });
        if (reservation.existing) return reservation.response;
        reserved = reservation.response;
        idempotencyId = reservation.idempotencyId;
        customerEmail = reservation.customerEmail;
        break;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && attempt < MAX_RESERVATION_ATTEMPTS) continue;
        throw error;
      }
    }
    if (!reserved! || !idempotencyId! || !customerEmail!) throw new AppError(503, 'Checkout reservation could not be completed');

    try {
      const initialized = await this.gateway.initializeTransaction({ amountCents: reserved.amountCents, currency: 'USD', customerEmail, reference: reserved.providerReference, idempotencyKey: key, metadata: { mode: 'test', subscriptionId: reserved.subscriptionId } });
      const completed: PersistedCheckout = { ...reserved, state: 'CHECKOUT_PENDING', authorizationUrl: initialized.authorizationUrl, accessCode: initialized.accessCode };
      await this.database.billingIdempotencyKey.update({ where: { id: idempotencyId }, data: { responseBody: asJson(completed), responseStatus: 202 } });
      return toCheckoutResponse(completed);
    } catch (error) {
      const known = error instanceof PaymentGatewayError;
      const unknownOutcome = !known || error.code === 'TIMEOUT' || error.code === 'NETWORK';
      const failed: PersistedCheckout = { ...reserved, state: unknownOutcome ? 'RECOVERY_REQUIRED' : 'FAILED', failureCode: known ? error.code : 'PROVIDER_FAILURE' };
      if (!unknownOutcome && known) {
        await this.database.billingPaymentAttempt.update({
          where: { id: reserved.paymentAttemptId },
          data: { status: BillingPaymentAttemptStatus.FAILED, failureCode: error.code, failureMessage: 'Provider initialization failed' },
        });
      }
      await this.database.billingIdempotencyKey.update({ where: { id: idempotencyId }, data: { status: unknownOutcome ? BillingIdempotencyStatus.IN_PROGRESS : BillingIdempotencyStatus.FAILED, responseBody: asJson(failed), responseStatus: unknownOutcome ? 202 : 502 } });
      if (unknownOutcome) return toCheckoutResponse(failed);
      throw new AppError(502, 'Checkout initialization failed');
    }
  }
}

export const billingService = new BillingService();
