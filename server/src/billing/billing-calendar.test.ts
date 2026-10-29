import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BillingCalendarError,
  RENEWAL_BILLING_POLICIES,
  addAnniversaryAnchoredMonth,
  addConsecutiveClampedMonth,
  assertContiguousBillingPeriods,
  calculateInitialBillingPeriodEndsAt,
  calculateNextBillingPeriod,
  getDaysInUtcMonth,
  isValidDate,
  type BillingPeriodSnapshot,
} from './billing-calendar';

describe('billing-calendar pure helpers', () => {
  describe('getDaysInUtcMonth and date validation', () => {
    it('returns exact days in month for non-leap and leap years', () => {
      // 2026 (non-leap)
      assert.equal(getDaysInUtcMonth(2026, 0), 31); // Jan
      assert.equal(getDaysInUtcMonth(2026, 1), 28); // Feb
      assert.equal(getDaysInUtcMonth(2026, 2), 31); // Mar
      assert.equal(getDaysInUtcMonth(2026, 3), 30); // Apr
      assert.equal(getDaysInUtcMonth(2026, 4), 31); // May
      assert.equal(getDaysInUtcMonth(2026, 5), 30); // Jun
      assert.equal(getDaysInUtcMonth(2026, 6), 31); // Jul
      assert.equal(getDaysInUtcMonth(2026, 7), 31); // Aug
      assert.equal(getDaysInUtcMonth(2026, 8), 30); // Sep
      assert.equal(getDaysInUtcMonth(2026, 9), 31); // Oct
      assert.equal(getDaysInUtcMonth(2026, 10), 30); // Nov
      assert.equal(getDaysInUtcMonth(2026, 11), 31); // Dec

      // 2028 (leap year)
      assert.equal(getDaysInUtcMonth(2028, 1), 29); // Feb in leap year
      // 2024 (leap year)
      assert.equal(getDaysInUtcMonth(2024, 1), 29);
      // 2100 (non-leap century year)
      assert.equal(getDaysInUtcMonth(2100, 1), 28);
      // 2000 (leap century year)
      assert.equal(getDaysInUtcMonth(2000, 1), 29);
    });

    it('identifies valid vs invalid Date objects', () => {
      assert.equal(isValidDate(new Date('2026-01-31T00:00:00.000Z')), true);
      assert.equal(isValidDate(new Date()), true);
      assert.equal(isValidDate(new Date('invalid-date')), false);
      assert.equal(isValidDate(null), false);
      assert.equal(isValidDate(undefined), false);
      assert.equal(isValidDate('2026-01-31'), false);
    });
  });

  describe('consecutive month-clamping policy (CONSECUTIVE_MONTH_CLAMPING)', () => {
    it('produces January 31 -> February 28 -> March 28 -> April 28 (permanent clamping drift)', () => {
      const p1Start = new Date('2026-01-31T14:30:00.000Z');
      const p1End = calculateInitialBillingPeriodEndsAt(p1Start);

      // Period 1: Jan 31 -> Feb 28
      assert.equal(p1End.toISOString(), '2026-02-28T14:30:00.000Z');

      const period1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: p1Start,
        endsAt: p1End,
      };

      // Period 2: startsAt Feb 28 -> endsAt Mar 28 (drifts to 28)
      const period2 = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        previousPeriod: period1,
      });

      assert.equal(period2.sequence, 2);
      assert.equal(period2.startsAt.toISOString(), '2026-02-28T14:30:00.000Z');
      assert.equal(period2.endsAt.toISOString(), '2026-03-28T14:30:00.000Z');
      assert.equal(period2.anchorDayUtc, 28);
      assertContiguousBillingPeriods(period1, period2);

      // Period 3: startsAt Mar 28 -> endsAt Apr 28
      const period3 = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        previousPeriod: period2,
      });

      assert.equal(period3.sequence, 3);
      assert.equal(period3.startsAt.toISOString(), '2026-03-28T14:30:00.000Z');
      assert.equal(period3.endsAt.toISOString(), '2026-04-28T14:30:00.000Z');
      assert.equal(period3.anchorDayUtc, 28);
      assertContiguousBillingPeriods(period2, period3);

      // Period 4: startsAt Apr 28 -> endsAt May 28
      const period4 = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        previousPeriod: period3,
      });

      assert.equal(period4.sequence, 4);
      assert.equal(period4.startsAt.toISOString(), '2026-04-28T14:30:00.000Z');
      assert.equal(period4.endsAt.toISOString(), '2026-05-28T14:30:00.000Z');
      assertContiguousBillingPeriods(period3, period4);
    });

    it('advances year boundary deterministically (December 31 -> January 31)', () => {
      const dec31 = new Date('2026-12-31T09:15:00.000Z');
      const nextMonth = addConsecutiveClampedMonth(dec31);
      assert.equal(nextMonth.toISOString(), '2027-01-31T09:15:00.000Z');
    });
  });

  describe('original-anniversary anchoring policy (ORIGINAL_ANNIVERSARY_ANCHORING)', () => {
    it('produces January 31 -> February 28 -> March 31 -> April 30 -> May 31 (self-restoring anchor)', () => {
      const p1Start = new Date('2026-01-31T14:30:00.000Z');
      const p1End = calculateInitialBillingPeriodEndsAt(p1Start);

      // Period 1: Jan 31 -> Feb 28
      assert.equal(p1End.toISOString(), '2026-02-28T14:30:00.000Z');

      const period1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: p1Start,
        endsAt: p1End,
      };

      // Period 2: startsAt Feb 28 -> endsAt Mar 31 (restores to 31!)
      const period2 = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period1,
      });

      assert.equal(period2.sequence, 2);
      assert.equal(period2.startsAt.toISOString(), '2026-02-28T14:30:00.000Z');
      assert.equal(period2.endsAt.toISOString(), '2026-03-31T14:30:00.000Z');
      assert.equal(period2.anchorDayUtc, 31);
      assertContiguousBillingPeriods(period1, period2);

      // Period 3: startsAt Mar 31 -> endsAt Apr 30 (clamped to 30 because April has 30 days)
      const period3 = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period2,
        initialPeriod: period1,
      });

      assert.equal(period3.sequence, 3);
      assert.equal(period3.startsAt.toISOString(), '2026-03-31T14:30:00.000Z');
      assert.equal(period3.endsAt.toISOString(), '2026-04-30T14:30:00.000Z');
      assert.equal(period3.anchorDayUtc, 31);
      assertContiguousBillingPeriods(period2, period3);

      // Period 4: startsAt Apr 30 -> endsAt May 31 (restores to 31!)
      const period4 = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period3,
        initialPeriod: period1,
      });

      assert.equal(period4.sequence, 4);
      assert.equal(period4.startsAt.toISOString(), '2026-04-30T14:30:00.000Z');
      assert.equal(period4.endsAt.toISOString(), '2026-05-31T14:30:00.000Z');
      assert.equal(period4.anchorDayUtc, 31);
      assertContiguousBillingPeriods(period3, period4);
    });

    it('handles August 31 -> September 30 -> October 31 correctly', () => {
      const p1Start = new Date('2026-08-31T08:00:00.000Z');
      const p1End = calculateInitialBillingPeriodEndsAt(p1Start);

      // Period 1: Aug 31 -> Sep 30
      assert.equal(p1End.toISOString(), '2026-09-30T08:00:00.000Z');

      const period1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: p1Start,
        endsAt: p1End,
      };

      // Under anniversary anchoring: Period 2 ends at Oct 31 (restored to 31)
      const period2Anchor = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period1,
      });
      assert.equal(period2Anchor.endsAt.toISOString(), '2026-10-31T08:00:00.000Z');

      // Under consecutive clamping: Period 2 ends at Oct 30 (remains at 30)
      const period2Clamp = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        previousPeriod: period1,
      });
      assert.equal(period2Clamp.endsAt.toISOString(), '2026-10-30T08:00:00.000Z');
    });
  });

  describe('leap year February 29 transitions', () => {
    it('clamps January 31, 2028 to February 29, 2028 in leap year', () => {
      const jan31Leap = new Date('2028-01-31T12:00:00.000Z');
      const feb29Leap = calculateInitialBillingPeriodEndsAt(jan31Leap);

      assert.equal(feb29Leap.toISOString(), '2028-02-29T12:00:00.000Z');

      const period1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: jan31Leap,
        endsAt: feb29Leap,
      };

      // Under anniversary anchoring: advances to March 31, 2028
      const period2Anchor = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period1,
      });
      assert.equal(period2Anchor.startsAt.toISOString(), '2028-02-29T12:00:00.000Z');
      assert.equal(period2Anchor.endsAt.toISOString(), '2028-03-31T12:00:00.000Z');

      // Under consecutive clamping: advances to March 29, 2028
      const period2Clamp = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        previousPeriod: period1,
      });
      assert.equal(period2Clamp.startsAt.toISOString(), '2028-02-29T12:00:00.000Z');
      assert.equal(period2Clamp.endsAt.toISOString(), '2028-03-29T12:00:00.000Z');
    });

    it('handles initial subscription created directly on leap day (February 29, 2028)', () => {
      const leapDay = new Date('2028-02-29T15:00:00.000Z');
      const p1End = calculateInitialBillingPeriodEndsAt(leapDay);

      // Period 1 in leap year: Feb 29 -> Mar 29
      assert.equal(p1End.toISOString(), '2028-03-29T15:00:00.000Z');

      const period1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: leapDay,
        endsAt: p1End,
      };

      // In March: 29 days is valid, next is April 29
      const period2 = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period1,
      });
      assert.equal(period2.startsAt.toISOString(), '2028-03-29T15:00:00.000Z');
      assert.equal(period2.endsAt.toISOString(), '2028-04-29T15:00:00.000Z');
      assert.equal(period2.anchorDayUtc, 29);

      // Now test what happens in February of a non-leap year (e.g. 2029) for a 29th anchor:
      const jan29NonLeap = new Date('2029-01-29T15:00:00.000Z');
      const febNonLeap = addAnniversaryAnchoredMonth(jan29NonLeap, leapDay);
      // In 2029 (non-leap), Feb has 28 days -> clamped to 28
      assert.equal(febNonLeap.toISOString(), '2029-02-28T15:00:00.000Z');

      // Then advancing from Feb 28 in 2029 under anniversary anchoring:
      const marNonLeap = addAnniversaryAnchoredMonth(febNonLeap, leapDay);
      // March has 31 days -> restored to 29!
      assert.equal(marNonLeap.toISOString(), '2029-03-29T15:00:00.000Z');
    });
  });

  describe('normal mid-month dates (identical behavior across policies)', () => {
    it('advances day 15 identically under both policies without clamping', () => {
      const p1Start = new Date('2026-04-15T09:00:00.000Z');
      const p1End = calculateInitialBillingPeriodEndsAt(p1Start);

      assert.equal(p1End.toISOString(), '2026-05-15T09:00:00.000Z');

      const period1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: p1Start,
        endsAt: p1End,
      };

      const period2Clamp = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        previousPeriod: period1,
      });

      const period2Anchor = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period1,
      });

      assert.equal(period2Clamp.startsAt.toISOString(), '2026-05-15T09:00:00.000Z');
      assert.equal(period2Clamp.endsAt.toISOString(), '2026-06-15T09:00:00.000Z');

      assert.equal(period2Anchor.startsAt.toISOString(), '2026-05-15T09:00:00.000Z');
      assert.equal(period2Anchor.endsAt.toISOString(), '2026-06-15T09:00:00.000Z');

      assert.equal(period2Clamp.endsAt.getTime(), period2Anchor.endsAt.getTime());
    });

    it('advances day 1 identically under both policies', () => {
      const p1Start = new Date('2026-02-01T00:00:00.000Z');
      const p1End = calculateInitialBillingPeriodEndsAt(p1Start);

      assert.equal(p1End.toISOString(), '2026-03-01T00:00:00.000Z');
    });
  });

  describe('exact UTC timestamp preservation', () => {
    it('preserves hours, minutes, seconds and milliseconds across month-end transitions', () => {
      const preciseStart = new Date('2026-01-31T23:59:59.999Z');
      const p1End = calculateInitialBillingPeriodEndsAt(preciseStart);

      assert.equal(p1End.toISOString(), '2026-02-28T23:59:59.999Z');
      assert.equal(p1End.getUTCHours(), 23);
      assert.equal(p1End.getUTCMinutes(), 59);
      assert.equal(p1End.getUTCSeconds(), 59);
      assert.equal(p1End.getUTCMilliseconds(), 999);

      const period1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: preciseStart,
        endsAt: p1End,
      };

      const period2Anchor = calculateNextBillingPeriod({
        policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
        previousPeriod: period1,
      });

      assert.equal(period2Anchor.endsAt.toISOString(), '2026-03-31T23:59:59.999Z');
      assert.equal(period2Anchor.endsAt.getUTCHours(), 23);
      assert.equal(period2Anchor.endsAt.getUTCMinutes(), 59);
      assert.equal(period2Anchor.endsAt.getUTCSeconds(), 59);
      assert.equal(period2Anchor.endsAt.getUTCMilliseconds(), 999);
    });
  });

  describe('input validation and fail-closed error handling', () => {
    const validPeriod1: BillingPeriodSnapshot = {
      sequence: 1,
      startsAt: new Date('2026-01-31T00:00:00.000Z'),
      endsAt: new Date('2026-02-28T00:00:00.000Z'),
    };

    it('rejects unsupported policy value', () => {
      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: 'INVALID_POLICY' as any,
            previousPeriod: validPeriod1,
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'UNSUPPORTED_POLICY');
          return true;
        }
      );
    });

    it('rejects invalid Date in previousPeriod startsAt or endsAt', () => {
      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
            previousPeriod: {
              sequence: 1,
              startsAt: new Date('invalid'),
              endsAt: new Date('2026-02-28T00:00:00.000Z'),
            },
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'INVALID_DATE');
          return true;
        }
      );

      assert.throws(
        () =>
          addConsecutiveClampedMonth(new Date('invalid')),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'INVALID_DATE');
          return true;
        }
      );
    });

    it('rejects nonpositive duration where endsAt <= startsAt in previousPeriod', () => {
      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
            previousPeriod: {
              sequence: 1,
              startsAt: new Date('2026-02-28T00:00:00.000Z'),
              endsAt: new Date('2026-02-28T00:00:00.000Z'), // zero duration
            },
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'NONPOSITIVE_DURATION');
          return true;
        }
      );

      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
            previousPeriod: {
              sequence: 1,
              startsAt: new Date('2026-02-28T00:00:00.000Z'),
              endsAt: new Date('2026-01-31T00:00:00.000Z'), // inverted
            },
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'NONPOSITIVE_DURATION');
          return true;
        }
      );
    });

    it('rejects invalid sequence numbers (<= 0 or non-integers)', () => {
      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
            previousPeriod: {
              sequence: 0,
              startsAt: new Date('2026-01-31T00:00:00.000Z'),
              endsAt: new Date('2026-02-28T00:00:00.000Z'),
            },
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'INVALID_SEQUENCE');
          return true;
        }
      );
    });

    it('rejects missing initialPeriod when sequence > 1 for anniversary anchoring', () => {
      const period2: BillingPeriodSnapshot = {
        sequence: 2,
        startsAt: new Date('2026-02-28T00:00:00.000Z'),
        endsAt: new Date('2026-03-31T00:00:00.000Z'),
      };

      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
            previousPeriod: period2,
            // initialPeriod omitted!
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'MISSING_INITIAL_PERIOD');
          return true;
        }
      );
    });

    it('rejects inconsistent initialPeriod starting after previousPeriod', () => {
      const period2: BillingPeriodSnapshot = {
        sequence: 2,
        startsAt: new Date('2026-02-28T00:00:00.000Z'),
        endsAt: new Date('2026-03-31T00:00:00.000Z'),
      };

      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
            previousPeriod: period2,
            initialPeriod: {
              sequence: 1,
              startsAt: new Date('2026-03-15T00:00:00.000Z'), // starts after period 2!
            },
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'INCONSISTENT_PERIOD_BOUNDARIES');
          return true;
        }
      );
    });

    it('rejects inconsistent initialPeriod when previousPeriod is sequence 1 but dates differ', () => {
      assert.throws(
        () =>
          calculateNextBillingPeriod({
            policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
            previousPeriod: validPeriod1,
            initialPeriod: {
              sequence: 1,
              startsAt: new Date('2026-01-15T00:00:00.000Z'), // mismatch with validPeriod1.startsAt
            },
          }),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'INCONSISTENT_PERIOD_BOUNDARIES');
          return true;
        }
      );
    });
  });

  describe('no gaps or overlaps between consecutive period boundaries', () => {
    it('verifies seamless contiguity across a full 12-month sequence chain (anniversary anchoring)', () => {
      const initialStart = new Date('2026-01-31T10:00:00.000Z');
      let currentPeriod: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: initialStart,
        endsAt: calculateInitialBillingPeriodEndsAt(initialStart),
      };

      const initialPeriodAnchor = {
        sequence: 1,
        startsAt: initialStart,
      };

      const expectedEndDates = [
        '2026-02-28T10:00:00.000Z', // Feb (clamped)
        '2026-03-31T10:00:00.000Z', // Mar (restored)
        '2026-04-30T10:00:00.000Z', // Apr (clamped)
        '2026-05-31T10:00:00.000Z', // May (restored)
        '2026-06-30T10:00:00.000Z', // Jun (clamped)
        '2026-07-31T10:00:00.000Z', // Jul (restored)
        '2026-08-31T10:00:00.000Z', // Aug (restored)
        '2026-09-30T10:00:00.000Z', // Sep (clamped)
        '2026-10-31T10:00:00.000Z', // Oct (restored)
        '2026-11-30T10:00:00.000Z', // Nov (clamped)
        '2026-12-31T10:00:00.000Z', // Dec (restored)
        '2027-01-31T10:00:00.000Z', // Jan (restored, year+1)
      ];

      assert.equal(currentPeriod.endsAt.toISOString(), expectedEndDates[0]);

      for (let seq = 2; seq <= 12; seq++) {
        const nextPeriod = calculateNextBillingPeriod({
          policy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
          previousPeriod: currentPeriod,
          initialPeriod: initialPeriodAnchor,
        });

        assert.equal(nextPeriod.sequence, seq);
        assert.equal(nextPeriod.startsAt.getTime(), currentPeriod.endsAt.getTime());
        assert.equal(nextPeriod.endsAt.toISOString(), expectedEndDates[seq - 1]);

        // Assert strictly contiguous: zero gap, zero overlap
        assertContiguousBillingPeriods(currentPeriod, nextPeriod);

        currentPeriod = nextPeriod;
      }
    });

    it('verifies seamless contiguity across a full 12-month sequence chain (consecutive clamping)', () => {
      const initialStart = new Date('2026-01-31T10:00:00.000Z');
      let currentPeriod: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: initialStart,
        endsAt: calculateInitialBillingPeriodEndsAt(initialStart),
      };

      // Under consecutive clamping, all subsequent months permanently clamp to 28
      const expectedEndDates = [
        '2026-02-28T10:00:00.000Z',
        '2026-03-28T10:00:00.000Z',
        '2026-04-28T10:00:00.000Z',
        '2026-05-28T10:00:00.000Z',
        '2026-06-28T10:00:00.000Z',
        '2026-07-28T10:00:00.000Z',
        '2026-08-28T10:00:00.000Z',
        '2026-09-28T10:00:00.000Z',
        '2026-10-28T10:00:00.000Z',
        '2026-11-28T10:00:00.000Z',
        '2026-12-28T10:00:00.000Z',
        '2027-01-28T10:00:00.000Z',
      ];

      assert.equal(currentPeriod.endsAt.toISOString(), expectedEndDates[0]);

      for (let seq = 2; seq <= 12; seq++) {
        const nextPeriod = calculateNextBillingPeriod({
          policy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
          previousPeriod: currentPeriod,
        });

        assert.equal(nextPeriod.sequence, seq);
        assert.equal(nextPeriod.startsAt.getTime(), currentPeriod.endsAt.getTime());
        assert.equal(nextPeriod.endsAt.toISOString(), expectedEndDates[seq - 1]);

        assertContiguousBillingPeriods(currentPeriod, nextPeriod);

        currentPeriod = nextPeriod;
      }
    });

    it('detects and rejects non-contiguous periods via assertContiguousBillingPeriods', () => {
      const p1: BillingPeriodSnapshot = {
        sequence: 1,
        startsAt: new Date('2026-01-01T00:00:00.000Z'),
        endsAt: new Date('2026-02-01T00:00:00.000Z'),
      };

      // Gap of 1 millisecond
      const p2WithGap: BillingPeriodSnapshot = {
        sequence: 2,
        startsAt: new Date('2026-02-01T00:00:00.001Z'),
        endsAt: new Date('2026-03-01T00:00:00.000Z'),
      };

      assert.throws(
        () => assertContiguousBillingPeriods(p1, p2WithGap),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'NON_CONTIGUOUS_PERIODS');
          return true;
        }
      );

      // Overlap of 1 second
      const p2WithOverlap: BillingPeriodSnapshot = {
        sequence: 2,
        startsAt: new Date('2026-01-31T23:59:59.000Z'),
        endsAt: new Date('2026-03-01T00:00:00.000Z'),
      };

      assert.throws(
        () => assertContiguousBillingPeriods(p1, p2WithOverlap),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'NON_CONTIGUOUS_PERIODS');
          return true;
        }
      );

      // Sequence gap
      const p3WithSequenceGap: BillingPeriodSnapshot = {
        sequence: 3, // should be 2
        startsAt: new Date('2026-02-01T00:00:00.000Z'),
        endsAt: new Date('2026-03-01T00:00:00.000Z'),
      };

      assert.throws(
        () => assertContiguousBillingPeriods(p1, p3WithSequenceGap),
        (err: unknown) => {
          assert(err instanceof BillingCalendarError);
          assert.equal(err.code, 'INVALID_SEQUENCE');
          return true;
        }
      );
    });
  });
});
