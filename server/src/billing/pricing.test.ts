import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSeatLimit,
  BillingCalculationError,
  buildProrationOperationId,
  calculateImmediateUpgradeProration,
  calculateMonthlyPriceCents,
  calculateNextCycleDowngrade,
  calculateSeatChangeProration,
  calculateSeatPricing,
  elapsedPeriodSeconds,
  extraStaffSeatPriceCents,
  includedStaffSeatCount,
  monthlyPriceCents,
  remainingPeriodCostCents,
  unusedPlanCreditCents,
} from './pricing';

const period = (start: string, end: string) => ({
  periodStart: new Date(start),
  periodEnd: new Date(end),
});

describe('billing plan catalog', () => {
  it('contains the official Starter base price', () => assert.equal(monthlyPriceCents('STARTER'), 2_000));
  it('contains the official Team base price', () => assert.equal(monthlyPriceCents('TEAM'), 5_000));
  it('contains the official Business base price', () => assert.equal(monthlyPriceCents('BUSINESS'), 12_000));

  it('rejects Starter sixth billable seat', () => {
    assert.throws(
      () => assertSeatLimit('STARTER', 6),
      (error: unknown) => error instanceof BillingCalculationError && error.code === 'STARTER_SEAT_LIMIT_EXCEEDED'
    );
  });

  it('prices Team extra seats at 300 cents each', () => {
    assert.equal(extraStaffSeatPriceCents('TEAM'), 300);
    assert.deepEqual(calculateSeatPricing('TEAM', 17), {
      billableStaffSeats: 17,
      includedStaffSeats: 15,
      extraStaffSeats: 2,
      extraStaffSeatPriceCents: 300,
      extraStaffAmountCents: 600,
      monthlyTotalCents: 5_600,
    });
  });

  it('prices Business extra seats at 200 cents each', () => {
    assert.equal(extraStaffSeatPriceCents('BUSINESS'), 200);
    assert.equal(calculateMonthlyPriceCents('BUSINESS', 43), 12_600);
  });

  it('excludes the owner by accepting only billable staff-seat counts', () => {
    assert.equal(includedStaffSeatCount('STARTER'), 5);
    assert.equal(calculateMonthlyPriceCents('STARTER', 5), 2_000);
  });
});

describe('proration', () => {
  it('matches the official 20-of-30-day Starter to Team example', () => {
    const result = calculateImmediateUpgradeProration(
      'STARTER',
      'TEAM',
      5,
      15,
      period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'),
      new Date('2030-01-11T00:00:00Z')
    );

    assert.equal(result.oldUnusedCreditCents, 1_333);
    assert.equal(result.newRemainingCostCents, 3_333);
    assert.equal(result.immediateChargeCents, 2_000);
    assert.equal(result.deferredCreditCents, 0);
  });

  it('charges the full difference at period start', () => {
    const result = calculateImmediateUpgradeProration(
      'STARTER',
      'TEAM',
      5,
      15,
      period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'),
      new Date('2030-01-01T00:00:00Z')
    );
    assert.equal(result.immediateChargeCents, 3_000);
    assert.equal(result.deferredCreditCents, 0);
  });

  it('rounds both costs down near period end', () => {
    const result = calculateImmediateUpgradeProration(
      'TEAM',
      'BUSINESS',
      15,
      40,
      period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'),
      new Date('2030-01-30T23:59:59Z')
    );
    assert.equal(result.oldUnusedCreditCents, 0);
    assert.equal(result.newRemainingCostCents, 0);
    assert.equal(result.immediateChargeCents, 0);
    assert.equal(result.deferredCreditCents, 0);
  });

  it('defers downgrades without an immediate refund', () => {
    const result = calculateNextCycleDowngrade(
      'BUSINESS',
      'TEAM',
      20,
      period('2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z')
    );
    assert.equal(result.deferred, true);
    assert.equal(result.immediateChargeCents, 0);
    assert.equal(result.immediateRefundCents, 0);
    assert.equal(result.effectiveAt.toISOString(), '2030-02-01T00:00:00.000Z');
  });

  it('flags required seat reduction for a Starter downgrade', () => {
    const result = calculateNextCycleDowngrade(
      'TEAM',
      'STARTER',
      6,
      period('2030-01-01T00:00:00Z', '2030-02-01T00:00:00Z')
    );
    assert.equal(result.requiresSeatReduction, true);
  });

  it('charges added Team extras for the remaining period', () => {
    const result = calculateSeatChangeProration(
      'TEAM',
      15,
      16,
      period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'),
      new Date('2030-01-16T00:00:00Z')
    );
    assert.equal(result.addedExtraSeats, 1);
    assert.equal(result.immediateChargeCents, 150);
    assert.equal(result.deferred, false);
  });

  it('defers seat reductions with no immediate refund', () => {
    const result = calculateSeatChangeProration(
      'TEAM',
      17,
      16,
      period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'),
      new Date('2030-01-16T00:00:00Z')
    );
    assert.equal(result.removedExtraSeats, 1);
    assert.equal(result.immediateChargeCents, 0);
    assert.equal(result.deferred, true);
  });

  it('uses the current effective paid state for a second same-period change', () => {
    const billingPeriod = period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z');
    const firstChange = calculateImmediateUpgradeProration(
      'STARTER', 'TEAM', 5, 15, billingPeriod, new Date('2030-01-11T00:00:00Z')
    );
    const secondChange = calculateImmediateUpgradeProration(
      'TEAM', 'BUSINESS', 15, 40, billingPeriod, new Date('2030-01-21T00:00:00Z')
    );
    assert.equal(firstChange.oldUnusedCreditCents, 1_333);
    assert.equal(secondChange.oldUnusedCreditCents, 1_666);
    assert.equal(secondChange.newRemainingCostCents, 4_000);
    assert.equal(secondChange.immediateChargeCents, 2_334);
    assert.equal(secondChange.deferredCreditCents, 0);
  });

  it('uses actual UTC elapsed seconds across a leap-year February period', () => {
    const billingPeriod = period('2032-02-01T00:00:00Z', '2032-03-01T00:00:00Z');
    assert.equal(elapsedPeriodSeconds(billingPeriod), 29 * 24 * 60 * 60);
    assert.equal(
      remainingPeriodCostCents('TEAM', 15, billingPeriod, new Date('2032-02-15T00:00:00Z')),
      Math.floor(5_000 * (15 * 24 * 60 * 60) / (29 * 24 * 60 * 60))
    );
  });

  it('uses UTC instants correctly across a DST-shaped offset change', () => {
    const billingPeriod = period('2030-03-09T00:00:00-05:00', '2030-03-11T00:00:00-04:00');
    assert.equal(elapsedPeriodSeconds(billingPeriod), 47 * 60 * 60);
  });

  it('rounds unused credit down independently', () => {
    const billingPeriod = period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z');
    assert.equal(unusedPlanCreditCents('STARTER', 5, billingPeriod, new Date('2030-01-11T00:00:00Z')), 1_333);
    assert.equal(remainingPeriodCostCents('TEAM', 15, billingPeriod, new Date('2030-01-11T00:00:00Z')), 3_333);
  });

  it('does not return a negative charge when extra-seat reduction outweighs a plan upgrade', () => {
    const result = calculateImmediateUpgradeProration(
      'TEAM',
      'BUSINESS',
      100,
      40,
      period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'),
      new Date('2030-01-11T00:00:00Z')
    );
    assert.equal(result.oldUnusedCreditCents, 20_333);
    assert.equal(result.newRemainingCostCents, 8_000);
    assert.equal(result.immediateChargeCents, 0);
    assert.equal(result.deferredCreditCents, 12_333);
  });
});

describe('billing calculation invariants', () => {
  it('rejects invalid periods', () => {
    assert.throws(
      () => elapsedPeriodSeconds(period('2030-01-02T00:00:00Z', '2030-01-01T00:00:00Z')),
      (error: unknown) => error instanceof BillingCalculationError && error.code === 'INVALID_PERIOD'
    );
  });

  it('rejects an effective time outside the period', () => {
    assert.throws(
      () => remainingPeriodCostCents(
        'TEAM',
        15,
        period('2030-01-01T00:00:00Z', '2030-01-31T00:00:00Z'),
        new Date('2030-02-01T00:00:00Z')
      ),
      (error: unknown) => error instanceof BillingCalculationError && error.code === 'INVALID_EFFECTIVE_TIME'
    );
  });

  it('creates a deterministic operation identifier without claiming persistence idempotency', () => {
    const identity = {
      subscriptionId: 'sub-123',
      effectiveAt: new Date('2030-01-11T00:00:00Z'),
      oldPlan: 'STARTER' as const,
      newPlan: 'TEAM' as const,
      oldBillableStaffSeats: 5,
      newBillableStaffSeats: 15,
    };
    assert.equal(buildProrationOperationId(identity), buildProrationOperationId(identity));
  });
});
