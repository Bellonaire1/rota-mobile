/**
 * Server-owned billing catalog and pure pricing calculations.
 *
 * Billable seats are active STAFF and MANAGER memberships. OWNER memberships
 * are deliberately excluded from every seat calculation in this module.
 * Monetary values are integer USD cents; floating-point arithmetic is never
 * used for a calculation.
 */

export type BillingPlanCode = 'STARTER' | 'TEAM' | 'BUSINESS';

export interface PlanDefinition {
  readonly code: BillingPlanCode;
  readonly monthlyPriceCents: number;
  readonly includedStaffSeats: number;
  readonly extraStaffSeatPriceCents: number;
}

export const PLAN_CATALOG = {
  STARTER: {
    code: 'STARTER',
    monthlyPriceCents: 2_000,
    includedStaffSeats: 5,
    extraStaffSeatPriceCents: 0,
  },
  TEAM: {
    code: 'TEAM',
    monthlyPriceCents: 5_000,
    includedStaffSeats: 15,
    extraStaffSeatPriceCents: 300,
  },
  BUSINESS: {
    code: 'BUSINESS',
    monthlyPriceCents: 12_000,
    includedStaffSeats: 40,
    extraStaffSeatPriceCents: 200,
  },
} as const satisfies Record<BillingPlanCode, PlanDefinition>;

const PLAN_RANK: Record<BillingPlanCode, number> = {
  STARTER: 1,
  TEAM: 2,
  BUSINESS: 3,
};

export type BillingCalculationErrorCode =
  | 'INVALID_PLAN'
  | 'INVALID_SEAT_COUNT'
  | 'STARTER_SEAT_LIMIT_EXCEEDED'
  | 'INVALID_PERIOD'
  | 'INVALID_EFFECTIVE_TIME'
  | 'NOT_AN_UPGRADE'
  | 'NOT_A_DOWNGRADE';

export class BillingCalculationError extends Error {
  constructor(
    public readonly code: BillingCalculationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BillingCalculationError';
  }
}

export interface BillingPeriod {
  periodStart: Date;
  periodEnd: Date;
}

export interface SeatPricing {
  billableStaffSeats: number;
  includedStaffSeats: number;
  extraStaffSeats: number;
  extraStaffSeatPriceCents: number;
  extraStaffAmountCents: number;
  monthlyTotalCents: number;
}

export interface ImmediateUpgradeProration {
  oldUnusedCreditCents: number;
  newRemainingCostCents: number;
  immediateChargeCents: number;
  deferredCreditCents: number;
  remainingSeconds: number;
  periodSeconds: number;
}

export interface SeatChangeProration {
  oldExtraSeatRemainingCostCents: number;
  newExtraSeatRemainingCostCents: number;
  addedExtraSeats: number;
  removedExtraSeats: number;
  immediateChargeCents: number;
  deferred: boolean;
  remainingSeconds: number;
  periodSeconds: number;
}

export interface NextCycleDowngrade {
  effectiveAt: Date;
  immediateChargeCents: 0;
  immediateRefundCents: 0;
  deferred: true;
  requiresSeatReduction: boolean;
}

export interface ProrationOperationIdentity {
  subscriptionId: string;
  effectiveAt: Date;
  oldPlan: BillingPlanCode;
  newPlan: BillingPlanCode;
  oldBillableStaffSeats: number;
  newBillableStaffSeats: number;
}

export const getPlan = (planCode: BillingPlanCode): PlanDefinition => {
  const plan = PLAN_CATALOG[planCode];
  if (!plan) {
    throw new BillingCalculationError('INVALID_PLAN', `Unknown billing plan: ${String(planCode)}`);
  }
  return plan;
};

export const monthlyPriceCents = (planCode: BillingPlanCode): number => getPlan(planCode).monthlyPriceCents;

export const includedStaffSeatCount = (planCode: BillingPlanCode): number => getPlan(planCode).includedStaffSeats;

export const extraStaffSeatPriceCents = (planCode: BillingPlanCode): number => getPlan(planCode).extraStaffSeatPriceCents;

const assertValidSeatCount = (billableStaffSeats: number): void => {
  if (!Number.isSafeInteger(billableStaffSeats) || billableStaffSeats < 0) {
    throw new BillingCalculationError('INVALID_SEAT_COUNT', 'Billable staff seats must be a nonnegative integer');
  }
};

export const assertSeatLimit = (planCode: BillingPlanCode, billableStaffSeats: number): void => {
  const plan = getPlan(planCode);
  assertValidSeatCount(billableStaffSeats);
  if (plan.extraStaffSeatPriceCents === 0 && billableStaffSeats > plan.includedStaffSeats) {
    throw new BillingCalculationError(
      'STARTER_SEAT_LIMIT_EXCEEDED',
      `${plan.code} supports at most ${plan.includedStaffSeats} billable staff seats`
    );
  }
};

export const calculateSeatPricing = (
  planCode: BillingPlanCode,
  billableStaffSeats: number
): SeatPricing => {
  const plan = getPlan(planCode);
  assertSeatLimit(planCode, billableStaffSeats);
  const extraStaffSeats = Math.max(0, billableStaffSeats - plan.includedStaffSeats);
  const extraStaffAmountCents = extraStaffSeats * plan.extraStaffSeatPriceCents;

  return {
    billableStaffSeats,
    includedStaffSeats: plan.includedStaffSeats,
    extraStaffSeats,
    extraStaffSeatPriceCents: plan.extraStaffSeatPriceCents,
    extraStaffAmountCents,
    monthlyTotalCents: plan.monthlyPriceCents + extraStaffAmountCents,
  };
};

export const calculateMonthlyPriceCents = (
  planCode: BillingPlanCode,
  billableStaffSeats: number
): number => calculateSeatPricing(planCode, billableStaffSeats).monthlyTotalCents;

const assertDate = (value: Date, label: string): void => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BillingCalculationError('INVALID_PERIOD', `${label} must be a valid Date`);
  }
  if (value.getTime() % 1_000 !== 0) {
    throw new BillingCalculationError('INVALID_PERIOD', `${label} must have whole-second precision`);
  }
};

const getPeriodSeconds = ({ periodStart, periodEnd }: BillingPeriod): number => {
  assertDate(periodStart, 'periodStart');
  assertDate(periodEnd, 'periodEnd');
  const milliseconds = periodEnd.getTime() - periodStart.getTime();
  if (milliseconds <= 0) {
    throw new BillingCalculationError('INVALID_PERIOD', 'periodEnd must be after periodStart');
  }
  return milliseconds / 1_000;
};

const getProrationWindow = (period: BillingPeriod, effectiveAt: Date) => {
  const periodSeconds = getPeriodSeconds(period);
  assertDate(effectiveAt, 'effectiveAt');
  if (effectiveAt < period.periodStart || effectiveAt > period.periodEnd) {
    throw new BillingCalculationError('INVALID_EFFECTIVE_TIME', 'effectiveAt must be within the billing period');
  }
  return {
    periodSeconds,
    remainingSeconds: (period.periodEnd.getTime() - effectiveAt.getTime()) / 1_000,
  };
};

const floorRatioCents = (amountCents: number, numerator: number, denominator: number): number => {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new BillingCalculationError('INVALID_PERIOD', 'Amounts must be nonnegative integer cents');
  }
  const result = (BigInt(amountCents) * BigInt(numerator)) / BigInt(denominator);
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new BillingCalculationError('INVALID_PERIOD', 'Calculated amount exceeds safe integer cents');
  }
  return Number(result);
};

const remainingCost = (
  monthlyAmountCents: number,
  period: BillingPeriod,
  effectiveAt: Date
): number => {
  const window = getProrationWindow(period, effectiveAt);
  return floorRatioCents(monthlyAmountCents, window.remainingSeconds, window.periodSeconds);
};

export const elapsedPeriodSeconds = (period: BillingPeriod): number => getPeriodSeconds(period);

export const unusedPlanCreditCents = (
  planCode: BillingPlanCode,
  billableStaffSeats: number,
  period: BillingPeriod,
  effectiveAt: Date
): number => remainingCost(calculateMonthlyPriceCents(planCode, billableStaffSeats), period, effectiveAt);

export const remainingPeriodCostCents = (
  planCode: BillingPlanCode,
  billableStaffSeats: number,
  period: BillingPeriod,
  effectiveAt: Date
): number => remainingCost(calculateMonthlyPriceCents(planCode, billableStaffSeats), period, effectiveAt);

export const calculateImmediateUpgradeProration = (
  oldPlanCode: BillingPlanCode,
  newPlanCode: BillingPlanCode,
  oldBillableStaffSeats: number,
  newBillableStaffSeats: number,
  period: BillingPeriod,
  effectiveAt: Date
): ImmediateUpgradeProration => {
  getPlan(oldPlanCode);
  getPlan(newPlanCode);
  if (PLAN_RANK[newPlanCode] <= PLAN_RANK[oldPlanCode]) {
    throw new BillingCalculationError('NOT_AN_UPGRADE', `${newPlanCode} is not an upgrade from ${oldPlanCode}`);
  }

  const window = getProrationWindow(period, effectiveAt);
  const oldUnusedCreditCents = floorRatioCents(
    calculateMonthlyPriceCents(oldPlanCode, oldBillableStaffSeats),
    window.remainingSeconds,
    window.periodSeconds
  );
  const newRemainingCostCents = floorRatioCents(
    calculateMonthlyPriceCents(newPlanCode, newBillableStaffSeats),
    window.remainingSeconds,
    window.periodSeconds
  );
  const netAdjustmentCents = newRemainingCostCents - oldUnusedCreditCents;

  return {
    oldUnusedCreditCents,
    newRemainingCostCents,
    immediateChargeCents: Math.max(0, netAdjustmentCents),
    // A seat reduction can make a nominal plan upgrade net negative. Do not
    // return a negative payment; carry that difference as a future credit.
    deferredCreditCents: Math.max(0, -netAdjustmentCents),
    remainingSeconds: window.remainingSeconds,
    periodSeconds: window.periodSeconds,
  };
};

export const calculateSeatChangeProration = (
  planCode: BillingPlanCode,
  oldBillableStaffSeats: number,
  newBillableStaffSeats: number,
  period: BillingPeriod,
  effectiveAt: Date
): SeatChangeProration => {
  const oldPricing = calculateSeatPricing(planCode, oldBillableStaffSeats);
  const newPricing = calculateSeatPricing(planCode, newBillableStaffSeats);
  const window = getProrationWindow(period, effectiveAt);
  const oldExtraSeatRemainingCostCents = floorRatioCents(
    oldPricing.extraStaffAmountCents,
    window.remainingSeconds,
    window.periodSeconds
  );
  const newExtraSeatRemainingCostCents = floorRatioCents(
    newPricing.extraStaffAmountCents,
    window.remainingSeconds,
    window.periodSeconds
  );
  const addedExtraSeats = Math.max(0, newPricing.extraStaffSeats - oldPricing.extraStaffSeats);
  const removedExtraSeats = Math.max(0, oldPricing.extraStaffSeats - newPricing.extraStaffSeats);
  const isReduction = newBillableStaffSeats < oldBillableStaffSeats;

  return {
    oldExtraSeatRemainingCostCents,
    newExtraSeatRemainingCostCents,
    addedExtraSeats,
    removedExtraSeats,
    immediateChargeCents: isReduction ? 0 : newExtraSeatRemainingCostCents - oldExtraSeatRemainingCostCents,
    deferred: isReduction,
    remainingSeconds: window.remainingSeconds,
    periodSeconds: window.periodSeconds,
  };
};

export const calculateNextCycleDowngrade = (
  oldPlanCode: BillingPlanCode,
  newPlanCode: BillingPlanCode,
  newBillableStaffSeats: number,
  period: BillingPeriod
): NextCycleDowngrade => {
  const newPlan = getPlan(newPlanCode);
  getPlan(oldPlanCode);
  assertValidSeatCount(newBillableStaffSeats);
  if (PLAN_RANK[newPlanCode] >= PLAN_RANK[oldPlanCode]) {
    throw new BillingCalculationError('NOT_A_DOWNGRADE', `${newPlanCode} is not a downgrade from ${oldPlanCode}`);
  }
  getPeriodSeconds(period);

  return {
    effectiveAt: new Date(period.periodEnd.getTime()),
    immediateChargeCents: 0,
    immediateRefundCents: 0,
    deferred: true,
    requiresSeatReduction: newPlan.extraStaffSeatPriceCents === 0
      && newBillableStaffSeats > newPlan.includedStaffSeats,
  };
};

export const buildProrationOperationId = (identity: ProrationOperationIdentity): string => {
  assertDate(identity.effectiveAt, 'effectiveAt');
  assertValidSeatCount(identity.oldBillableStaffSeats);
  assertValidSeatCount(identity.newBillableStaffSeats);
  return [
    'proration',
    identity.subscriptionId,
    identity.effectiveAt.toISOString(),
    identity.oldPlan,
    identity.newPlan,
    identity.oldBillableStaffSeats,
    identity.newBillableStaffSeats,
  ].join(':');
};
