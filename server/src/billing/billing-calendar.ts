/**
 * Pure UTC billing-calendar calculations for subscription billing periods.
 *
 * This module defines standalone date and period advancement helpers supporting
 * two distinct month-end calendar policies:
 * 1. CONSECUTIVE_MONTH_CLAMPING:
 *    Each subsequent period end is clamped to the number of days in the next month
 *    relative to the immediate previous period end (e.g., Jan 31 -> Feb 28 -> Mar 28).
 * 2. ORIGINAL_ANNIVERSARY_ANCHORING:
 *    Each subsequent period end restores to the initial period's anchor day if the
 *    target month has sufficient days (e.g., Jan 31 -> Feb 28 -> Mar 31).
 *
 * Neither policy is activated in production checkout or settlement in this module;
 * calculations remain pure and standalone pending final billing-policy decisions.
 */

export const RENEWAL_BILLING_POLICIES = {
  CONSECUTIVE_MONTH_CLAMPING: 'CONSECUTIVE_MONTH_CLAMPING',
  ORIGINAL_ANNIVERSARY_ANCHORING: 'ORIGINAL_ANNIVERSARY_ANCHORING',
} as const;

export type RenewalBillingPolicy =
  (typeof RENEWAL_BILLING_POLICIES)[keyof typeof RENEWAL_BILLING_POLICIES];

export type BillingCalendarErrorCode =
  | 'UNSUPPORTED_POLICY'
  | 'INVALID_DATE'
  | 'NONPOSITIVE_DURATION'
  | 'INVALID_SEQUENCE'
  | 'INCONSISTENT_PERIOD_BOUNDARIES'
  | 'MISSING_INITIAL_PERIOD'
  | 'NON_CONTIGUOUS_PERIODS';

export class BillingCalendarError extends Error {
  constructor(
    public readonly code: BillingCalendarErrorCode,
    message: string
  ) {
    super(`[${code}] ${message}`);
    this.name = 'BillingCalendarError';
  }
}

export interface BillingPeriodSnapshot {
  readonly sequence: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface InitialBillingPeriodAnchor {
  readonly sequence?: number;
  readonly startsAt: Date;
  readonly endsAt?: Date;
}

export interface CalculateNextBillingPeriodInput {
  readonly policy: RenewalBillingPolicy;
  readonly previousPeriod: BillingPeriodSnapshot;
  readonly initialPeriod?: InitialBillingPeriodAnchor;
}

export interface CandidateBillingPeriod {
  readonly sequence: number;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly policy: RenewalBillingPolicy;
  readonly anchorDayUtc: number;
}

export const isValidDate = (value: unknown): value is Date => {
  return value instanceof Date && !Number.isNaN(value.getTime());
};

/**
 * Returns the exact number of days in the specified month in UTC.
 * @param year Full 4-digit year (e.g. 2026)
 * @param monthIndex 0-indexed month (0 = January, 11 = December)
 */
export const getDaysInUtcMonth = (year: number, monthIndex: number): number => {
  // Day 0 of monthIndex + 1 gives the final day of monthIndex in UTC
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
};

/**
 * Pure consecutive month advancement with month-end clamping.
 * Takes the start date, increments the UTC month by 1, and clamps the resulting
 * date to the maximum days in the target month while strictly preserving UTC
 * hours, minutes, seconds and milliseconds.
 */
export const addConsecutiveClampedMonth = (start: Date): Date => {
  if (!isValidDate(start)) {
    throw new BillingCalendarError('INVALID_DATE', 'Input start date is invalid');
  }

  const startDay = start.getUTCDate();
  const startMonth = start.getUTCMonth();
  const startYear = start.getUTCFullYear();
  const hours = start.getUTCHours();
  const minutes = start.getUTCMinutes();
  const seconds = start.getUTCSeconds();
  const ms = start.getUTCMilliseconds();

  let targetYear = startYear;
  let targetMonth = startMonth + 1;
  if (targetMonth > 11) {
    targetYear += Math.floor(targetMonth / 12);
    targetMonth = targetMonth % 12;
  }

  const daysInTargetMonth = getDaysInUtcMonth(targetYear, targetMonth);
  const targetDay = Math.min(startDay, daysInTargetMonth);

  return new Date(Date.UTC(targetYear, targetMonth, targetDay, hours, minutes, seconds, ms));
};

/**
 * Pure anniversary-anchored month advancement.
 * Advances from currentPeriodStart by 1 UTC month, but anchors the target day
 * to initialAnchor's UTC day-of-month (clamped only if target month has fewer days).
 * Strictly preserves the UTC time of initialAnchor (hours, minutes, seconds, ms).
 */
export const addAnniversaryAnchoredMonth = (
  currentPeriodStart: Date,
  initialAnchor: Date
): Date => {
  if (!isValidDate(currentPeriodStart)) {
    throw new BillingCalendarError('INVALID_DATE', 'Input currentPeriodStart date is invalid');
  }
  if (!isValidDate(initialAnchor)) {
    throw new BillingCalendarError('INVALID_DATE', 'Input initialAnchor date is invalid');
  }

  const anchorDay = initialAnchor.getUTCDate();
  const hours = initialAnchor.getUTCHours();
  const minutes = initialAnchor.getUTCMinutes();
  const seconds = initialAnchor.getUTCSeconds();
  const ms = initialAnchor.getUTCMilliseconds();

  const currentMonth = currentPeriodStart.getUTCMonth();
  const currentYear = currentPeriodStart.getUTCFullYear();

  let targetYear = currentYear;
  let targetMonth = currentMonth + 1;
  if (targetMonth > 11) {
    targetYear += Math.floor(targetMonth / 12);
    targetMonth = targetMonth % 12;
  }

  const daysInTargetMonth = getDaysInUtcMonth(targetYear, targetMonth);
  const targetDay = Math.min(anchorDay, daysInTargetMonth);

  return new Date(Date.UTC(targetYear, targetMonth, targetDay, hours, minutes, seconds, ms));
};

/**
 * Calculates candidate endsAt for sequence 1 (initial subscription period).
 * For initial period, both policies produce identical results.
 */
export const calculateInitialBillingPeriodEndsAt = (startsAt: Date): Date => {
  return addConsecutiveClampedMonth(startsAt);
};

/**
 * Calculates candidate next BillingPeriod boundaries for a given policy.
 * - nextStartsAt strictly equals previousPeriod.endsAt (zero gaps, zero overlaps).
 * - nextEndsAt is computed via CONSECUTIVE_MONTH_CLAMPING or ORIGINAL_ANNIVERSARY_ANCHORING.
 * - Fails closed on invalid inputs, inconsistent boundaries or nonpositive durations.
 */
export const calculateNextBillingPeriod = (
  input: CalculateNextBillingPeriodInput
): CandidateBillingPeriod => {
  if (!input || typeof input !== 'object') {
    throw new BillingCalendarError('INVALID_DATE', 'Input must be an object');
  }

  // 1. Policy validation
  const policy = input.policy;
  if (
    policy !== RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING &&
    policy !== RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING
  ) {
    throw new BillingCalendarError(
      'UNSUPPORTED_POLICY',
      `Unsupported billing policy: ${String(policy)}`
    );
  }

  // 2. Previous Period validation
  const prev = input.previousPeriod;
  if (!prev || typeof prev !== 'object') {
    throw new BillingCalendarError('INVALID_DATE', 'previousPeriod must be provided');
  }

  if (typeof prev.sequence !== 'number' || !Number.isSafeInteger(prev.sequence) || prev.sequence < 1) {
    throw new BillingCalendarError(
      'INVALID_SEQUENCE',
      `previousPeriod.sequence must be a positive integer >= 1; got ${prev.sequence}`
    );
  }

  if (!isValidDate(prev.startsAt) || !isValidDate(prev.endsAt)) {
    throw new BillingCalendarError('INVALID_DATE', 'previousPeriod contains invalid dates');
  }

  if (prev.endsAt.getTime() <= prev.startsAt.getTime()) {
    throw new BillingCalendarError(
      'NONPOSITIVE_DURATION',
      `previousPeriod endsAt (${prev.endsAt.toISOString()}) must be strictly after startsAt (${prev.startsAt.toISOString()})`
    );
  }

  // 3. Resolve Anchor Period for Anniversary Anchoring
  let anchorPeriodStart: Date;
  if (policy === RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING) {
    if (prev.sequence === 1) {
      if (input.initialPeriod?.startsAt) {
        if (!isValidDate(input.initialPeriod.startsAt)) {
          throw new BillingCalendarError('INVALID_DATE', 'initialPeriod.startsAt is invalid');
        }
        if (input.initialPeriod.startsAt.getTime() !== prev.startsAt.getTime()) {
          throw new BillingCalendarError(
            'INCONSISTENT_PERIOD_BOUNDARIES',
            `initialPeriod.startsAt (${input.initialPeriod.startsAt.toISOString()}) does not match sequence-1 startsAt (${prev.startsAt.toISOString()})`
          );
        }
      }
      anchorPeriodStart = prev.startsAt;
    } else {
      if (!input.initialPeriod || !input.initialPeriod.startsAt) {
        throw new BillingCalendarError(
          'MISSING_INITIAL_PERIOD',
          'initialPeriod (sequence 1) is required for ORIGINAL_ANNIVERSARY_ANCHORING when previousPeriod sequence > 1'
        );
      }
      if (!isValidDate(input.initialPeriod.startsAt)) {
        throw new BillingCalendarError('INVALID_DATE', 'initialPeriod.startsAt is invalid');
      }
      if (input.initialPeriod.sequence !== undefined && input.initialPeriod.sequence !== 1) {
        throw new BillingCalendarError(
          'INVALID_SEQUENCE',
          `initialPeriod sequence must be 1; got ${input.initialPeriod.sequence}`
        );
      }
      if (input.initialPeriod.startsAt.getTime() > prev.startsAt.getTime()) {
        throw new BillingCalendarError(
          'INCONSISTENT_PERIOD_BOUNDARIES',
          `initialPeriod.startsAt (${input.initialPeriod.startsAt.toISOString()}) cannot start after previousPeriod.startsAt (${prev.startsAt.toISOString()})`
        );
      }
      anchorPeriodStart = input.initialPeriod.startsAt;
    }
  } else {
    // For CONSECUTIVE_MONTH_CLAMPING, anchor is taken from the previous period end
    anchorPeriodStart = prev.endsAt;
  }

  // 4. Calculate Explicit Period Boundaries
  const nextSequence = prev.sequence + 1;
  const nextStartsAt = new Date(prev.endsAt.getTime());

  let nextEndsAt: Date;
  let anchorDayUtc: number;

  if (policy === RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING) {
    nextEndsAt = addConsecutiveClampedMonth(nextStartsAt);
    anchorDayUtc = nextStartsAt.getUTCDate();
  } else {
    nextEndsAt = addAnniversaryAnchoredMonth(nextStartsAt, anchorPeriodStart);
    anchorDayUtc = anchorPeriodStart.getUTCDate();
  }

  if (nextEndsAt.getTime() <= nextStartsAt.getTime()) {
    throw new BillingCalendarError(
      'NONPOSITIVE_DURATION',
      `Calculated candidate endsAt (${nextEndsAt.toISOString()}) must be strictly after startsAt (${nextStartsAt.toISOString()})`
    );
  }

  return {
    sequence: nextSequence,
    startsAt: nextStartsAt,
    endsAt: nextEndsAt,
    policy,
    anchorDayUtc,
  };
};

/**
 * Asserts that two adjacent billing periods are strictly contiguous:
 * - sequence is monotonically incremented (+1).
 * - next.startsAt exactly equals previous.endsAt (no gaps, no overlaps).
 * - both periods have strictly positive duration.
 */
export const assertContiguousBillingPeriods = (
  previous: BillingPeriodSnapshot,
  next: BillingPeriodSnapshot
): void => {
  if (!isValidDate(previous.startsAt) || !isValidDate(previous.endsAt)) {
    throw new BillingCalendarError('INVALID_DATE', 'previous period dates are invalid');
  }
  if (!isValidDate(next.startsAt) || !isValidDate(next.endsAt)) {
    throw new BillingCalendarError('INVALID_DATE', 'next period dates are invalid');
  }
  if (next.sequence !== previous.sequence + 1) {
    throw new BillingCalendarError(
      'INVALID_SEQUENCE',
      `Next sequence (${next.sequence}) must be exactly previous sequence (${previous.sequence}) + 1`
    );
  }
  if (next.startsAt.getTime() !== previous.endsAt.getTime()) {
    throw new BillingCalendarError(
      'NON_CONTIGUOUS_PERIODS',
      `Next startsAt (${next.startsAt.toISOString()}) must equal previous endsAt (${previous.endsAt.toISOString()})`
    );
  }
  if (next.endsAt.getTime() <= next.startsAt.getTime()) {
    throw new BillingCalendarError(
      'NONPOSITIVE_DURATION',
      `Next endsAt (${next.endsAt.toISOString()}) must be strictly after startsAt (${next.startsAt.toISOString()})`
    );
  }
};
