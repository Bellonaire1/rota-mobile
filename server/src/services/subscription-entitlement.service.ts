import {
  BillingIdempotencyStatus,
  BillingPlanCode,
  BillingPeriodStatus,
  BillingSubscriptionStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { AppError } from '../errors/AppError';

export const GRACE_PERIOD_DAYS = 7;

export type EntitlementDatabase = PrismaClient | Prisma.TransactionClient;
export type EffectiveSubscriptionStatus = BillingSubscriptionStatus | 'NO_SUBSCRIPTION';

export type SubscriptionEntitlement = {
  subscriptionId?: string;
  status: EffectiveSubscriptionStatus;
  planCode: BillingPlanCode | null;
  paidBillableStaffSeats: number | null;
  currentBillableStaffSeats: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const addGracePeriod = (periodEnd: Date): Date => (
  new Date(periodEnd.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1_000)
);

export const getEffectiveSubscriptionStatus = (
  status: BillingSubscriptionStatus,
  currentPeriodEnd: Date | null,
  gracePeriodEndsAt: Date | null,
  now: Date,
): BillingSubscriptionStatus => {
  const graceEnd = gracePeriodEndsAt ?? (currentPeriodEnd ? addGracePeriod(currentPeriodEnd) : null);
  if (status === BillingSubscriptionStatus.ACTIVE && currentPeriodEnd && now >= currentPeriodEnd) {
    return graceEnd && now >= graceEnd
      ? BillingSubscriptionStatus.SUSPENDED
      : BillingSubscriptionStatus.GRACE;
  }
  if ((status === BillingSubscriptionStatus.PAST_DUE || status === BillingSubscriptionStatus.GRACE)
    && graceEnd && now >= graceEnd) {
    return BillingSubscriptionStatus.SUSPENDED;
  }
  return status;
};

const pendingSeatSnapshot = (value: Prisma.JsonValue | null): number | null => {
  if (!isRecord(value) || !Number.isSafeInteger(value.billableStaffSeats) || Number(value.billableStaffSeats) < 0) {
    return null;
  }
  return Number(value.billableStaffSeats);
};

export const resolveSubscriptionEntitlement = async (
  database: EntitlementDatabase,
  teamId: string,
  now = new Date(),
): Promise<SubscriptionEntitlement> => {
  const subscription = await database.billingSubscription.findUnique({
    where: { teamId },
    select: {
      id: true,
      status: true,
      currentPeriodEnd: true,
      gracePeriodEndsAt: true,
      currentPlan: { select: { code: true } },
    },
  });

  const currentBillableStaffSeats = await database.teamMembership.count({
    where: { teamId, role: { in: ['STAFF', 'MANAGER'] } },
  });

  if (!subscription) {
    return { status: 'NO_SUBSCRIPTION', planCode: null, paidBillableStaffSeats: null, currentBillableStaffSeats };
  }

  const status = getEffectiveSubscriptionStatus(
    subscription.status,
    subscription.currentPeriodEnd,
    subscription.gracePeriodEndsAt,
    now,
  );

  if (subscription.status === BillingSubscriptionStatus.PENDING_CHECKOUT) {
    const operation = await database.billingIdempotencyKey.findFirst({
      where: {
        teamId,
        scope: `team-billing-checkout:${teamId}`,
        status: { in: [BillingIdempotencyStatus.IN_PROGRESS, BillingIdempotencyStatus.SUCCEEDED] },
      },
      orderBy: { createdAt: 'desc' },
      select: { responseBody: true },
    });
    return {
      subscriptionId: subscription.id,
      status,
      planCode: subscription.currentPlan.code,
      paidBillableStaffSeats: pendingSeatSnapshot(operation?.responseBody ?? null),
      currentBillableStaffSeats,
    };
  }

  const period = await database.billingPeriod.findFirst({
    where: {
      subscriptionId: subscription.id,
      startsAt: { lte: now },
      status: { not: BillingPeriodStatus.VOID },
    },
    orderBy: { sequence: 'desc' },
    select: { billableStaffSeats: true, planCodeSnapshot: true },
  });

  return {
    subscriptionId: subscription.id,
    status,
    planCode: period?.planCodeSnapshot ?? subscription.currentPlan.code,
    paidBillableStaffSeats: period?.billableStaffSeats ?? null,
    currentBillableStaffSeats,
  };
};

export const assertMembershipSeatEntitlement = (
  entitlement: SubscriptionEntitlement,
  nextBillableStaffSeats: number,
): void => {
  if (entitlement.status === 'NO_SUBSCRIPTION' || nextBillableStaffSeats <= entitlement.currentBillableStaffSeats) return;

  if (entitlement.status === BillingSubscriptionStatus.SUSPENDED
    || entitlement.status === BillingSubscriptionStatus.CANCELED) {
    throw new AppError(409, 'Subscription does not permit adding billable team members');
  }

  if (entitlement.planCode === BillingPlanCode.STARTER && nextBillableStaffSeats > 5) {
    throw new AppError(409, 'Adding this member would exceed the Starter five-seat cap');
  }

  if (entitlement.paidBillableStaffSeats === null
    || nextBillableStaffSeats > entitlement.paidBillableStaffSeats) {
    throw new AppError(409, 'Adding this member would exceed the paid billable seat entitlement');
  }
};

export const assertOperationalMutationEntitlement = (
  entitlement: SubscriptionEntitlement,
): void => {
  if (entitlement.status === BillingSubscriptionStatus.SUSPENDED) {
    throw new AppError(409, 'Subscription is suspended; operational changes are unavailable');
  }
  if (entitlement.status === BillingSubscriptionStatus.CANCELED) {
    throw new AppError(409, 'Subscription is canceled; operational changes are unavailable');
  }
};
