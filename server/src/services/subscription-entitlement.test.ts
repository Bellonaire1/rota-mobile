import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BillingPlanCode, BillingSubscriptionStatus } from '@prisma/client';
import {
  GRACE_PERIOD_DAYS,
  assertMembershipSeatEntitlement,
  assertOperationalMutationEntitlement,
  getEffectiveSubscriptionStatus,
  type SubscriptionEntitlement,
} from './subscription-entitlement.service';

const entitlement = (overrides: Partial<SubscriptionEntitlement> = {}): SubscriptionEntitlement => ({
  status: BillingSubscriptionStatus.ACTIVE,
  planCode: BillingPlanCode.STARTER,
  paidBillableStaffSeats: 5,
  currentBillableStaffSeats: 5,
  ...overrides,
});

describe('subscription entitlement policy', () => {
  it('treats an expired ACTIVE period as GRACE for seven days, then SUSPENDED', () => {
    const periodEnd = new Date('2030-01-01T00:00:00.000Z');
    assert.equal(
      getEffectiveSubscriptionStatus(BillingSubscriptionStatus.ACTIVE, periodEnd, null, new Date('2030-01-03T00:00:00.000Z')),
      BillingSubscriptionStatus.GRACE,
    );
    assert.equal(
      getEffectiveSubscriptionStatus(BillingSubscriptionStatus.ACTIVE, periodEnd, null, new Date(`2030-01-${String(1 + GRACE_PERIOD_DAYS).padStart(2, '0')}T00:00:00.000Z`)),
      BillingSubscriptionStatus.SUSPENDED,
    );
  });

  it('expires explicit GRACE and PAST_DUE deadlines without mutating stored state', () => {
    const graceEnd = new Date('2030-02-01T00:00:00.000Z');
    assert.equal(
      getEffectiveSubscriptionStatus(BillingSubscriptionStatus.GRACE, null, graceEnd, new Date('2030-01-31T23:59:59.000Z')),
      BillingSubscriptionStatus.GRACE,
    );
    assert.equal(
      getEffectiveSubscriptionStatus(BillingSubscriptionStatus.PAST_DUE, null, graceEnd, new Date('2030-02-01T00:00:00.000Z')),
      BillingSubscriptionStatus.SUSPENDED,
    );
  });

  it('allows reductions and rejects expansion beyond the paid seat entitlement', () => {
    assert.doesNotThrow(() => assertMembershipSeatEntitlement(entitlement(), 4));
    assert.doesNotThrow(() => assertMembershipSeatEntitlement(entitlement(), 5));
    assert.throws(
      () => assertMembershipSeatEntitlement(entitlement(), 6),
      /seat entitlement|Starter five-seat cap/,
    );
  });

  it('keeps the Starter five-seat cap independent of the saved paid count', () => {
    assert.throws(
      () => assertMembershipSeatEntitlement(entitlement({ paidBillableStaffSeats: 10, currentBillableStaffSeats: 5 }), 6),
      /Starter five-seat cap/,
    );
  });

  it('blocks additions for suspended and canceled subscriptions but permits reductions', () => {
    for (const status of [BillingSubscriptionStatus.SUSPENDED, BillingSubscriptionStatus.CANCELED]) {
      assert.doesNotThrow(() => assertMembershipSeatEntitlement(entitlement({ status }), 4));
      assert.throws(
        () => assertMembershipSeatEntitlement(entitlement({ status }), 6),
        /adding billable team members/,
      );
    }
  });

  it('allows operational writes through grace but blocks suspended and canceled writes', () => {
    for (const status of [
      'NO_SUBSCRIPTION',
      BillingSubscriptionStatus.PENDING_CHECKOUT,
      BillingSubscriptionStatus.ACTIVE,
      BillingSubscriptionStatus.PAST_DUE,
      BillingSubscriptionStatus.GRACE,
    ] as const) {
      assert.doesNotThrow(() => assertOperationalMutationEntitlement(entitlement({ status })));
    }
    assert.throws(
      () => assertOperationalMutationEntitlement(entitlement({ status: BillingSubscriptionStatus.SUSPENDED })),
      /operational changes are unavailable/,
    );
    assert.throws(
      () => assertOperationalMutationEntitlement(entitlement({ status: BillingSubscriptionStatus.CANCELED })),
      /operational changes are unavailable/,
    );
  });
});
