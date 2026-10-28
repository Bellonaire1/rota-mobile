import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MalformedRenewalHintError,
  computeRenewalCycleCandidate,
  isSupportedRenewalEventType,
  parseRenewalEventHint,
} from './paystack-renewal.service';

describe('Paystack renewal event identification', () => {
  describe('supported event types', () => {
    it('recognizes supported Paystack renewal event types', () => {
      assert.equal(isSupportedRenewalEventType('invoice.create'), true);
      assert.equal(isSupportedRenewalEventType('invoice.update'), true);
      assert.equal(isSupportedRenewalEventType('invoice.payment_failed'), true);
      assert.equal(isSupportedRenewalEventType('charge.success'), true);
      assert.equal(isSupportedRenewalEventType('subscription.create'), false);
      assert.equal(isSupportedRenewalEventType('charge.dispute.create'), false);
      assert.equal(isSupportedRenewalEventType('transfer.success'), false);
    });

    it('rejects unsupported event types', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'subscription.disable', data: {} }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'UNSUPPORTED_EVENT_TYPE'
      );
    });
  });

  describe('valid renewal event parsing and cycle identification', () => {
    it('parses valid invoice.create with invoice_code as trustworthy cycle identity', () => {
      const payload = {
        event: 'invoice.create',
        data: {
          invoice_code: 'INV_2026_cycle_02',
          amount: 2_000,
          currency: 'USD',
          status: 'pending',
          paid: false,
          period_start: '2026-11-01T00:00:00.000Z',
          period_end: '2026-12-01T00:00:00.000Z',
          subscription: {
            subscription_code: 'SUB_test_sub_123',
            status: 'active',
            amount: 2_000,
            plan: {
              plan_code: 'PLN_starter_monthly',
              amount: 2_000,
              currency: 'USD',
              interval: 'monthly',
            },
          },
          customer: {
            customer_code: 'CUS_test_cust_456',
            email: 'billing@example.com',
          },
        },
      };

      const hint = parseRenewalEventHint(payload);

      assert.equal(hint.eventType, 'invoice.create');
      assert.equal(hint.provider, 'paystack');
      assert.equal(hint.subscription?.subscriptionCode, 'SUB_test_sub_123');
      assert.equal(hint.customer?.customerCode, 'CUS_test_cust_456');
      assert.equal(hint.plan?.planCode, 'PLN_starter_monthly');
      assert.equal(hint.invoice?.invoiceCode, 'INV_2026_cycle_02');
      assert.equal(hint.invoice?.status, 'pending');
      assert.equal(hint.invoice?.paid, false);
      assert.equal(hint.amountCents, 2_000);
      assert.equal(hint.currency, 'USD');
      assert.equal(hint.period?.periodStart?.toISOString(), '2026-11-01T00:00:00.000Z');
      assert.equal(hint.period?.periodEnd?.toISOString(), '2026-12-01T00:00:00.000Z');

      // Cycle identification
      assert.equal(hint.cycleCandidate.hasStableCycleCandidate, true);
      assert.equal(hint.cycleCandidate.candidateType, 'INVOICE_CODE');
      assert.equal(hint.cycleCandidate.candidateKey, 'SUB_test_sub_123:INV_2026_cycle_02');
      assert.equal(hint.cycleCandidate.candidateLimitations.length, 0);
    });

    it('parses valid invoice.update with transaction details', () => {
      const payload = {
        event: 'invoice.update',
        data: {
          invoice_code: 'INV_2026_cycle_02',
          amount: 2_000,
          currency: 'USD',
          status: 'success',
          paid: true,
          paid_at: '2026-11-01T08:15:30.000Z',
          subscription: {
            subscription_code: 'SUB_test_sub_123',
            status: 'active',
          },
          customer: {
            customer_code: 'CUS_test_cust_456',
          },
          transaction: {
            reference: 'T_ren_9928192839',
            status: 'success',
            amount: 2_000,
            paid_at: '2026-11-01T08:15:30.000Z',
          },
        },
      };

      const hint = parseRenewalEventHint(payload, 'invoice.update');

      assert.equal(hint.eventType, 'invoice.update');
      assert.equal(hint.invoice?.paid, true);
      assert.equal(hint.transaction?.reference, 'T_ren_9928192839');
      assert.equal(hint.cycleCandidate.hasStableCycleCandidate, true);
      assert.equal(hint.cycleCandidate.candidateKey, 'SUB_test_sub_123:INV_2026_cycle_02');
    });

    it('parses valid invoice.payment_failed with numeric invoice ID', () => {
      const payload = {
        event: 'invoice.payment_failed',
        data: {
          id: 9948271,
          amount: 2_000,
          currency: 'USD',
          status: 'failed',
          paid: false,
          subscription: {
            subscription_code: 'SUB_test_sub_123',
            status: 'attention',
            plan: {
              plan_code: 'PLN_starter_monthly',
              currency: 'USD',
            },
          },
          customer: {
            customer_code: 'CUS_test_cust_456',
          },
          reference: 'T_fail_8847291',
        },
      };

      const hint = parseRenewalEventHint(payload);

      assert.equal(hint.eventType, 'invoice.payment_failed');
      assert.equal(hint.invoice?.invoiceId, '9948271');
      assert.equal(hint.invoice?.status, 'failed');
      assert.equal(hint.invoice?.paid, false);
      assert.equal(hint.transaction?.reference, 'T_fail_8847291');
      assert.equal(hint.cycleCandidate.hasStableCycleCandidate, true);
      assert.equal(hint.cycleCandidate.candidateType, 'INVOICE_ID');
      assert.equal(hint.cycleCandidate.candidateKey, 'SUB_test_sub_123:id:9948271');
    });
  });

  describe('distinct renewal cycles and cycle isolation', () => {
    it('generates distinct cycle identities for sequential cycles on the same subscription', () => {
      const cycle1Payload = {
        event: 'invoice.create',
        data: {
          invoice_code: 'INV_cycle_month_01',
          subscription_code: 'SUB_main_branch_99',
        },
      };
      const cycle2Payload = {
        event: 'invoice.create',
        data: {
          invoice_code: 'INV_cycle_month_02',
          subscription_code: 'SUB_main_branch_99',
        },
      };

      const hint1 = parseRenewalEventHint(cycle1Payload);
      const hint2 = parseRenewalEventHint(cycle2Payload);

      assert.notEqual(hint1.cycleCandidate.candidateKey, hint2.cycleCandidate.candidateKey);
      assert.equal(hint1.cycleCandidate.candidateKey, 'SUB_main_branch_99:INV_cycle_month_01');
      assert.equal(hint2.cycleCandidate.candidateKey, 'SUB_main_branch_99:INV_cycle_month_02');
    });
  });

  describe('explicitly flags insufficient candidate evidence and limitations', () => {
    it('flags cycle as lacking stable candidate when only period boundaries are available without invoice code/id', () => {
      const payload = {
        event: 'charge.success',
        data: {
          subscription_code: 'SUB_test_sub_123',
          customer_code: 'CUS_test_cust_456',
          plan_code: 'PLN_starter_monthly',
          amount: 2_000,
          currency: 'USD',
          period_start: '2026-11-01T00:00:00.000Z',
          period_end: '2026-12-01T00:00:00.000Z',
        },
      };

      const hint = parseRenewalEventHint(payload);

      assert.equal(hint.cycleCandidate.hasStableCycleCandidate, false);
      assert.equal(hint.cycleCandidate.candidateType, 'PERIOD_BOUNDS');
      assert.match(hint.cycleCandidate.candidateKey ?? '', /^SUB_test_sub_123:period:/);
      assert.ok(hint.cycleCandidate.candidateLimitations.some((r) => r.includes('UNCONFIRMED_INVOICE_IDENTITY')));
    });

    it('flags cycle as lacking stable candidate when only transaction reference is available', () => {
      const payload = {
        event: 'charge.success',
        data: {
          subscription_code: 'SUB_test_sub_123',
          customer_code: 'CUS_test_cust_456',
          reference: 'T_renew_tx_only_01',
          amount: 2_000,
          currency: 'USD',
        },
      };

      const hint = parseRenewalEventHint(payload);

      assert.equal(hint.cycleCandidate.hasStableCycleCandidate, false);
      assert.equal(hint.cycleCandidate.candidateType, 'TRANSACTION_ONLY');
      assert.equal(hint.cycleCandidate.candidateKey, 'SUB_test_sub_123:tx:T_renew_tx_only_01');
      assert.ok(hint.cycleCandidate.candidateLimitations.some((r) => r.includes('UNCONFIRMED_CYCLE_IDENTITY')));
    });

    it('flags cycle as NONE when subscription code is absent', () => {
      const payload = {
        event: 'invoice.create',
        data: {
          invoice_code: 'INV_orphan_invoice_99',
          customer_code: 'CUS_test_cust_456',
        },
      };

      const hint = parseRenewalEventHint(payload);

      assert.equal(hint.cycleCandidate.hasStableCycleCandidate, false);
      assert.equal(hint.cycleCandidate.candidateType, 'NONE');
      assert.equal(hint.cycleCandidate.candidateKey, null);
      assert.ok(hint.cycleCandidate.candidateLimitations.some((r) => r.includes('MISSING_SUBSCRIPTION_IDENTITY')));
    });

    it('flags cycle as NONE when event has subscription code but no cycle evidence', () => {
      const candidate = computeRenewalCycleCandidate({
        eventType: 'invoice.create',
        provider: 'paystack',
        subscription: { subscriptionCode: 'SUB_test_sub_123' },
      });

      assert.equal(candidate.hasStableCycleCandidate, false);
      assert.equal(candidate.candidateType, 'NONE');
      assert.equal(candidate.candidateKey, null);
      assert.ok(candidate.candidateLimitations.some((r) => r.includes('MISSING_CYCLE_IDENTITY')));
    });
  });

  describe('rejects contradictory identities (fail-closed)', () => {
    it('rejects contradictory subscription codes between top-level and nested', () => {
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              subscription_code: 'SUB_code_aaa_111',
              subscription: { subscription_code: 'SUB_code_bbb_222' },
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_SUBSCRIPTION_CODE'
      );
    });

    it('rejects contradictory customer codes between data.customer and data.subscription.customer', () => {
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              customer: { customer_code: 'CUS_real_customer_11' },
              subscription: {
                subscription_code: 'SUB_valid_123',
                customer: { customer_code: 'CUS_conflicting_22' },
              },
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_CUSTOMER_CODE'
      );
    });

    it('rejects contradictory plan codes between data.plan and data.subscription.plan', () => {
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              plan: { plan_code: 'PLN_starter_01' },
              subscription: {
                subscription_code: 'SUB_valid_123',
                plan: { plan_code: 'PLN_business_99' },
              },
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_PLAN_CODE'
      );
    });

    it('rejects contradictory currencies between invoice and plan', () => {
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              currency: 'USD',
              plan: { plan_code: 'PLN_valid_123', currency: 'NGN' },
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_CURRENCY'
      );
    });

    it('rejects contradictory amounts between invoice and subscription', () => {
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              amount: 2_000,
              subscription: { subscription_code: 'SUB_valid_123', amount: 5_000 },
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_AMOUNT'
      );
    });

    it('rejects contradictory amounts between invoice and transaction', () => {
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.update',
            data: {
              amount: 2_000,
              transaction: { reference: 'T_valid_123', amount: 3_000 },
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_AMOUNT'
      );
    });

    it('rejects inverted or contradictory period range where period_end <= period_start', () => {
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              period_start: '2026-12-01T00:00:00.000Z',
              period_end: '2026-11-01T00:00:00.000Z',
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_PERIOD'
      );

      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              period_start: '2026-12-01T00:00:00.000Z',
              period_end: '2026-12-01T00:00:00.000Z',
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_PERIOD'
      );
    });

    it('rejects contradictory payment states', () => {
      // Unpaid with paid_at date
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.create',
            data: {
              paid: false,
              paid_at: '2026-11-01T00:00:00.000Z',
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_PAYMENT_STATE'
      );

      // Failed with paid=true
      assert.throws(
        () =>
          parseRenewalEventHint({
            event: 'invoice.payment_failed',
            data: {
              status: 'failed',
              paid: true,
            },
          }),
        (err: unknown) =>
          err instanceof MalformedRenewalHintError && err.reasonCode === 'CONTRADICTORY_PAYMENT_STATE'
      );
    });
  });

  describe('rejects malformed code formats and invalid numbers', () => {
    it('rejects malformed subscription codes', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { subscription_code: 'INVALID_NO_PREFIX' } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'INVALID_SUBSCRIPTION_CODE'
      );
    });

    it('rejects malformed customer codes', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { customer_code: 'BAD_CUS_FORMAT' } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'INVALID_CUSTOMER_CODE'
      );
    });

    it('rejects malformed plan codes', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { plan_code: 'NOT_A_PLAN' } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'INVALID_PLAN_CODE'
      );
    });

    it('rejects malformed invoice codes', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { invoice_code: 'INVALID_INVOICE' } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'INVALID_INVOICE_CODE'
      );
    });

    it('rejects invalid or negative amounts', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { amount: -500 } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'INVALID_AMOUNT'
      );
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { amount: 12.34 } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'INVALID_AMOUNT'
      );
    });

    it('rejects USD amounts below the $2 minimum', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { amount: 150, currency: 'USD' } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'AMOUNT_BELOW_MINIMUM'
      );
    });

    it('rejects invalid date strings', () => {
      assert.throws(
        () => parseRenewalEventHint({ event: 'invoice.create', data: { period_start: 'not-a-valid-date' } }),
        (err: unknown) => err instanceof MalformedRenewalHintError && err.reasonCode === 'INVALID_DATE'
      );
    });
  });

  describe('never fabricates absent fields and ignores initial checkout metadata', () => {
    it('keeps absent fields undefined rather than fabricating defaults', () => {
      const hint = parseRenewalEventHint({
        event: 'invoice.create',
        data: {
          invoice_code: 'INV_minimal_01',
          subscription_code: 'SUB_minimal_01',
        },
      });

      assert.equal(hint.amountCents, undefined);
      assert.equal(hint.currency, undefined);
      assert.equal(hint.period?.periodStart, undefined);
      assert.equal(hint.period?.periodEnd, undefined);
      assert.equal(hint.customer, undefined);
      assert.equal(hint.plan, undefined);
      assert.equal(hint.transaction, undefined);
    });

    it('does not assume or require initial checkout metadata', () => {
      // Renewal webhooks lack teamId, initial subscriptionId, or client idempotency keys
      const renewalPayload = {
        event: 'invoice.update',
        data: {
          invoice_code: 'INV_ren_clean_01',
          subscription_code: 'SUB_ren_clean_01',
          amount: 2_000,
          currency: 'USD',
          // Note: no metadata property, no teamId, no checkout idempotency keys
        },
      };

      const hint = parseRenewalEventHint(renewalPayload);
      assert.equal(hint.subscription?.subscriptionCode, 'SUB_ren_clean_01');
      assert.equal(hint.cycleCandidate.hasStableCycleCandidate, true);
    });

    it('deterministically handles duplicate deliveries identically', () => {
      const payload = {
        event: 'invoice.update',
        data: {
          invoice_code: 'INV_dup_test_01',
          subscription_code: 'SUB_dup_test_01',
          amount: 2_000,
          currency: 'USD',
        },
      };

      const first = parseRenewalEventHint(payload);
      const second = parseRenewalEventHint(payload);

      assert.deepEqual(first, second);
      assert.equal(first.cycleCandidate.candidateKey, second.cycleCandidate.candidateKey);
    });
  });
});
