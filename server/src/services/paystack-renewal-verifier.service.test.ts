import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BillingSubscriptionStatus } from '@prisma/client';
import {
  PaymentGatewayError,
  type CreatePlanInput,
  type FetchPlanByCodeInput,
  type FetchSubscriptionByCodeInput,
  type InitializePaymentInput,
  type PaymentGateway,
  type PaymentInitialization,
  type ProviderPlan,
  type VerifiedPayment,
  type VerifiedSubscription,
  type VerifyPaymentInput,
} from '../billing/payments';
import { parseRenewalEventHint, type UntrustedRenewalEventHint } from './paystack-renewal.service';
import {
  PaystackRenewalVerifier,
  type RenewalVerificationDatabase,
} from './paystack-renewal-verifier.service';

class TestRenewalGateway implements PaymentGateway {
  public fetchSubscriptionCallCount = 0;
  public verifyTransactionCallCount = 0;
  private subscriptions = new Map<string, VerifiedSubscription | PaymentGatewayError | null>();
  private transactions = new Map<string, VerifiedPayment | PaymentGatewayError>();

  setSubscription(code: string, result: VerifiedSubscription | PaymentGatewayError | null): void {
    this.subscriptions.set(code, result);
  }

  setTransaction(reference: string, result: VerifiedPayment | PaymentGatewayError): void {
    this.transactions.set(reference, result);
  }

  async fetchSubscriptionByCode(input: FetchSubscriptionByCodeInput): Promise<VerifiedSubscription | null> {
    this.fetchSubscriptionCallCount++;
    if (!this.subscriptions.has(input.subscriptionCode)) {
      return null;
    }
    const res = this.subscriptions.get(input.subscriptionCode);
    if (res instanceof PaymentGatewayError) throw res;
    return res ?? null;
  }

  async verifyTransaction(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    this.verifyTransactionCallCount++;
    if (!this.transactions.has(input.reference)) {
      throw new PaymentGatewayError('PROVIDER_FAILURE', `Transaction ${input.reference} not found`);
    }
    const res = this.transactions.get(input.reference);
    if (res instanceof PaymentGatewayError) throw res;
    return res!;
  }

  async initializeTransaction(_input: InitializePaymentInput): Promise<PaymentInitialization> {
    throw new Error('initializeTransaction not used in renewal verification');
  }

  async createPlan(_input: CreatePlanInput): Promise<ProviderPlan> {
    throw new Error('createPlan not used in renewal verification');
  }

  async fetchPlanByCode(_input: FetchPlanByCodeInput): Promise<ProviderPlan | null> {
    throw new Error('fetchPlanByCode not used in renewal verification');
  }
}

interface MockDatabaseState {
  subscriptions?: any[];
  invoices?: any[];
  paymentAttempts?: any[];
}

const createMockDatabase = (state: MockDatabaseState = {}): RenewalVerificationDatabase => {
  const subscriptions = state.subscriptions ?? [];
  const invoices = state.invoices ?? [];
  const paymentAttempts = state.paymentAttempts ?? [];

  return {
    billingSubscription: {
      findUnique: async ({ where }: { where: { providerSubscriptionId: string } }) => {
        const found = subscriptions.find((s) => s.providerSubscriptionId === where.providerSubscriptionId);
        return found ? JSON.parse(JSON.stringify(found)) : null;
      },
    },
    billingInvoice: {
      findUnique: async ({ where }: { where: { providerInvoiceId: string } }) => {
        const found = invoices.find((inv) => inv.providerInvoiceId === where.providerInvoiceId);
        return found ? JSON.parse(JSON.stringify(found)) : null;
      },
    },
    billingPaymentAttempt: {
      findUnique: async ({ where }: { where: { providerPaymentId: string } }) => {
        const found = paymentAttempts.find((att) => att.providerPaymentId === where.providerPaymentId);
        return found ? JSON.parse(JSON.stringify(found)) : null;
      },
    },
  } as unknown as RenewalVerificationDatabase;
};

const createValidLocalSubscription = (overrides: Record<string, any> = {}) => ({
  id: 'sub_local_123',
  teamId: 'team_test_123',
  providerSubscriptionId: 'SUB_test_sub_123',
  providerCustomerId: 'CUS_test_cust_456',
  status: BillingSubscriptionStatus.ACTIVE,
  currency: 'USD',
  currentPlan: {
    code: 'PLN_starter_monthly',
  },
  currentPrice: {
    monthlyPriceCents: 2000,
  },
  periods: [
    {
      sequence: 1,
      planCodeSnapshot: 'PLN_starter_monthly',
      totalAmountCents: 2000,
    },
  ],
  ...overrides,
});

const createValidVerifiedSubscription = (overrides: Partial<VerifiedSubscription> = {}): VerifiedSubscription => ({
  providerSubscriptionId: '123456',
  subscriptionCode: 'SUB_test_sub_123',
  customerCode: 'CUS_test_cust_456',
  planCode: 'PLN_starter_monthly',
  amountCents: 2000,
  currency: 'USD',
  interval: 'monthly',
  status: 'active',
  ...overrides,
});

const createValidVerifiedPayment = (overrides: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  reference: 'T_ren_123456789',
  providerTransactionId: '987654321',
  providerCustomerId: 'CUS_test_cust_456',
  amountCents: 2000,
  currency: 'USD',
  status: 'success',
  ...overrides,
});

const createValidRenewalHint = (overrides: Record<string, any> = {}): UntrustedRenewalEventHint => {
  const basePayload = {
    event: 'charge.success',
    data: {
      reference: 'T_ren_123456789',
      id: 987654321,
      amount: 2000,
      currency: 'USD',
      status: 'success',
      paid_at: '2026-11-01T00:05:00.000Z',
      invoice_code: 'INV_2026_cycle_02',
      subscription: {
        subscription_code: 'SUB_test_sub_123',
        status: 'active',
        amount: 2000,
        plan: {
          plan_code: 'PLN_starter_monthly',
          amount: 2000,
          currency: 'USD',
          interval: 'monthly',
        },
      },
      customer: {
        customer_code: 'CUS_test_cust_456',
        email: 'billing@example.com',
      },
      ...overrides,
    },
  };
  return parseRenewalEventHint(basePayload);
};

describe('PaystackRenewalVerifier', () => {
  describe('successful verification pending cycle proof', () => {
    it('verifies valid subscription and transaction while preserving INSUFFICIENT_CYCLE_PROOF', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);

      assert.equal(result.outcome, 'VERIFIED_PENDING_CYCLE_PROOF');
      assert.equal(result.isReadyForSettlement, false);
      assert.equal(result.cycleProof.cycleProofStatus, 'INSUFFICIENT_CYCLE_PROOF');
      assert.equal(result.cycleProof.hasIndependentProviderProof, false);
      assert.ok(result.cycleProof.reasons.length > 0);

      // Subscription proof details
      assert.deepEqual(result.subscriptionProof, {
        providerSubscriptionId: '123456',
        subscriptionCode: 'SUB_test_sub_123',
        providerCustomerId: 'CUS_test_cust_456',
        planCode: 'PLN_starter_monthly',
        amountCents: 2000,
        currency: 'USD',
        interval: 'monthly',
        status: 'active',
        localSubscriptionId: 'sub_local_123',
        teamId: 'team_test_123',
      });

      // Transaction proof details
      assert.deepEqual(result.transactionProof, {
        reference: 'T_ren_123456789',
        providerTransactionId: '987654321',
        providerCustomerId: 'CUS_test_cust_456',
        amountCents: 2000,
        currency: 'USD',
        status: 'success',
      });
    });

    it('handles hint without candidate transaction (e.g. invoice.create) returning INSUFFICIENT_CYCLE_PROOF', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const invoiceHint = parseRenewalEventHint({
        event: 'invoice.create',
        data: {
          invoice_code: 'INV_2026_cycle_02',
          amount: 2000,
          currency: 'USD',
          status: 'pending',
          paid: false,
          subscription: {
            subscription_code: 'SUB_test_sub_123',
            status: 'active',
            amount: 2000,
            plan: {
              plan_code: 'PLN_starter_monthly',
              amount: 2000,
              currency: 'USD',
              interval: 'monthly',
            },
          },
          customer: {
            customer_code: 'CUS_test_cust_456',
            email: 'billing@example.com',
          },
        },
      });

      const result = await verifier.verifyRenewal(invoiceHint);

      assert.equal(result.outcome, 'INSUFFICIENT_CYCLE_PROOF');
      assert.equal(result.isReadyForSettlement, false);
      assert.ok(result.subscriptionProof);
      assert.equal(result.transactionProof, undefined);
      assert.equal(result.cycleProof.cycleProofStatus, 'INSUFFICIENT_CYCLE_PROOF');
    });

    it('falls back to current plan and price when periods array is empty', async () => {
      const localSub = createValidLocalSubscription({ periods: [] });
      const db = createMockDatabase({
        subscriptions: [localSub],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'VERIFIED_PENDING_CYCLE_PROOF');
      assert.equal(result.subscriptionProof?.amountCents, 2000);
      assert.equal(result.subscriptionProof?.planCode, 'PLN_starter_monthly');
    });

    it('does NOT require initial checkout metadata for renewal transactions', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'VERIFIED_PENDING_CYCLE_PROOF');
    });
  });

  describe('local subscription loading and validation', () => {
    it('fails closed when hint lacks subscription code', async () => {
      const db = createMockDatabase();
      const gateway = new TestRenewalGateway();
      const verifier = new PaystackRenewalVerifier(db, gateway);

      const invalidHint: UntrustedRenewalEventHint = {
        eventType: 'charge.success',
        provider: 'paystack',
        amountCents: 2000,
        currency: 'USD',
        cycleCandidate: {
          candidateKey: null,
          candidateType: 'TRANSACTION_ONLY',
          hasStableCycleCandidate: false,
          candidateLimitations: [],
        },
      };

      const result = await verifier.verifyRenewal(invalidHint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /provider subscription code/);
    });

    it('fails closed when subscription is not found in local DB', async () => {
      const db = createMockDatabase({ subscriptions: [] });
      const gateway = new TestRenewalGateway();
      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /No local subscription matches/);
    });

    it('fails closed when local subscription status is not ACTIVE', async () => {
      const db = createMockDatabase({
        subscriptions: [
          createValidLocalSubscription({ status: BillingSubscriptionStatus.PENDING_CHECKOUT }),
        ],
      });
      const gateway = new TestRenewalGateway();
      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /require ACTIVE status/);
    });

    it('fails closed when local subscription lacks providerCustomerId', async () => {
      const db = createMockDatabase({
        subscriptions: [
          createValidLocalSubscription({ providerCustomerId: null }),
        ],
      });
      const gateway = new TestRenewalGateway();
      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /providerCustomerId/);
    });

    it('fails closed when local subscription currency is not USD', async () => {
      const db = createMockDatabase({
        subscriptions: [
          createValidLocalSubscription({ currency: 'NGN' }),
        ],
      });
      const gateway = new TestRenewalGateway();
      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /expected USD/);
    });
  });

  describe('independent provider subscription verification', () => {
    it('returns DEFINITIVE_CONTRADICTION when provider subscription is not found', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', null);

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /not found on Paystack/);
    });

    it('returns DEFINITIVE_CONTRADICTION when provider customer code mismatches', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        createValidVerifiedSubscription({ customerCode: 'CUS_other_cust_999' })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /do not match expected local subscription identities/);
    });

    it('returns DEFINITIVE_CONTRADICTION when provider plan code mismatches', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        createValidVerifiedSubscription({ planCode: 'PLN_other_plan_999' })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /do not match expected local subscription identities/);
    });

    it('returns DEFINITIVE_CONTRADICTION when provider amount mismatches', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        createValidVerifiedSubscription({ amountCents: 9999 })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /do not match expected local subscription identities/);
    });

    it('returns DEFINITIVE_CONTRADICTION when provider subscription status is not active', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        createValidVerifiedSubscription({ status: 'non-renewing' as any })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /do not match expected local subscription identities/);
    });

    it('returns PROVIDER_OUTAGE on subscription lookup timeout/network error', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        new PaymentGatewayError('TIMEOUT', 'Subscription request timed out')
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'PROVIDER_OUTAGE');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Provider subscription lookup outage/);
    });

    it('returns PROVIDER_OUTAGE on provider failure (HTTP 500/502/PROVIDER_FAILURE)', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        new PaymentGatewayError('HTTP', 'Paystack service unavailable (HTTP 503)')
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'PROVIDER_OUTAGE');
      assert.match(result.error ?? '', /Provider subscription lookup outage/);
    });
  });

  describe('invoice code cross-subscription conflict detection', () => {
    it('returns CONFLICT when provider invoice code is bound to another subscription', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
        invoices: [
          {
            id: 'inv_other_999',
            subscriptionId: 'sub_foreign_another_team',
            providerInvoiceId: 'INV_2026_cycle_02',
          },
        ],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'CONFLICT');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /already bound to another subscription/);
    });

    it('allows invoice code if bound to the same subscription (replay / idempotent check)', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
        invoices: [
          {
            id: 'inv_same_123',
            subscriptionId: 'sub_local_123',
            providerInvoiceId: 'INV_2026_cycle_02',
          },
        ],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'VERIFIED_PENDING_CYCLE_PROOF');
    });
  });

  describe('independent candidate transaction verification', () => {
    it('returns PROVIDER_OUTAGE when transaction verification experiences network outage', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction(
        'T_ren_123456789',
        new PaymentGatewayError('NETWORK', 'Failed to connect to Paystack')
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'PROVIDER_OUTAGE');
      assert.equal(result.isReadyForSettlement, false);
      assert.ok(result.subscriptionProof);
      assert.match(result.error ?? '', /Provider transaction verification outage/);
    });

    it('returns DEFINITIVE_CONTRADICTION when transaction verification returns non-success status', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction(
        'T_ren_123456789',
        createValidVerifiedPayment({ status: 'failed' as any })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /Verified transaction attributes do not match/);
    });

    it('returns DEFINITIVE_CONTRADICTION when transaction amount mismatches expected amount', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction(
        'T_ren_123456789',
        createValidVerifiedPayment({ amountCents: 5000 })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /Verified transaction attributes do not match/);
    });

    it('returns DEFINITIVE_CONTRADICTION when transaction customer code does not match subscription customer', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction(
        'T_ren_123456789',
        createValidVerifiedPayment({ providerCustomerId: 'CUS_intruder_attacker_999' })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /does not match subscription customer code/);
    });

    it('returns CONFLICT when transaction ID is already used on another subscription', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
        paymentAttempts: [
          {
            id: 'att_other_999',
            providerPaymentId: '987654321',
            invoice: {
              id: 'inv_other_999',
              subscriptionId: 'sub_foreign_another_team',
            },
          },
        ],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'CONFLICT');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /already linked to another subscription/);
    });

    it('flags isReplayCandidate when transaction ID was already recorded on the SAME subscription', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
        paymentAttempts: [
          {
            id: 'att_same_123',
            providerPaymentId: '987654321',
            invoice: {
              id: 'inv_same_123',
              subscriptionId: 'sub_local_123',
            },
          },
        ],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'VERIFIED_PENDING_CYCLE_PROOF');
      assert.equal(result.isReplayCandidate, true);
      assert.equal(result.isReadyForSettlement, false);
      assert.equal(result.cycleProof.cycleProofStatus, 'INSUFFICIENT_CYCLE_PROOF');
    });

    it('returns DEFINITIVE_CONTRADICTION when verified transaction lacks providerCustomerId', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction(
        'T_ren_123456789',
        createValidVerifiedPayment({ providerCustomerId: undefined })
      );

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Verified transaction lacks a provider customer ID/);
    });
  });

  describe('strict identity consistency checks (Task 5E.3C3A-FIX1)', () => {
    it('rejects incorrect webhook customer before making gateway calls', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint({
        customer: {
          customer_code: 'CUS_intruder_wrong_999',
          email: 'intruder@example.com',
        },
      });

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Webhook customer code .* does not match local subscription customer code/);
      assert.equal(gateway.fetchSubscriptionCallCount, 0, 'Rejection must occur before fetchSubscriptionByCode');
      assert.equal(gateway.verifyTransactionCallCount, 0, 'Rejection must occur before verifyTransaction');
    });

    it('rejects incorrect webhook amount before making gateway calls', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint({
        amount: 9999,
        subscription: {
          subscription_code: 'SUB_test_sub_123',
          status: 'active',
          amount: 9999,
          plan: {
            plan_code: 'PLN_starter_monthly',
            amount: 9999,
            currency: 'USD',
            interval: 'monthly',
          },
        },
      });

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Webhook amount .* does not match expected renewal amount/);
      assert.equal(gateway.fetchSubscriptionCallCount, 0, 'Rejection must occur before fetchSubscriptionByCode');
      assert.equal(gateway.verifyTransactionCallCount, 0, 'Rejection must occur before verifyTransaction');
    });

    it('rejects incorrect supplied webhook plan before making gateway calls', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint({
        plan: {
          plan_code: 'PLN_wrong_enterprise_yearly',
          amount: 2000,
          currency: 'USD',
          interval: 'monthly',
        },
        subscription: {
          subscription_code: 'SUB_test_sub_123',
          status: 'active',
          amount: 2000,
          plan: {
            plan_code: 'PLN_wrong_enterprise_yearly',
            amount: 2000,
            currency: 'USD',
            interval: 'monthly',
          },
        },
      });

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Webhook plan code .* does not match expected provider plan code/);
      assert.equal(gateway.fetchSubscriptionCallCount, 0, 'Rejection must occur before fetchSubscriptionByCode');
      assert.equal(gateway.verifyTransactionCallCount, 0, 'Rejection must occur before verifyTransaction');
    });

    it('resolves expected provider plan code from authoritative recurring checkout evidence when local plan is Rota enum', async () => {
      const db = createMockDatabase({
        subscriptions: [
          createValidLocalSubscription({
            currentPlan: { code: 'STARTER' },
            periods: [
              {
                sequence: 1,
                planCodeSnapshot: 'STARTER',
                totalAmountCents: 2000,
              },
            ],
            invoices: [
              {
                id: 'inv_init_123',
                paymentAttempts: [
                  {
                    id: 'att_init_123',
                    idempotencyRecord: {
                      responseBody: {
                        recurring: true,
                        providerPlanCode: 'PLN_starter_checkout_authoritative',
                        amountCents: 2000,
                        planCode: 'STARTER',
                      },
                    },
                  },
                ],
              },
            ],
          }),
        ],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        createValidVerifiedSubscription({ planCode: 'PLN_starter_checkout_authoritative' })
      );
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint({
        subscription: {
          subscription_code: 'SUB_test_sub_123',
          plan: {
            plan_code: 'PLN_starter_checkout_authoritative',
            amount: 2000,
            currency: 'USD',
            interval: 'monthly',
          },
        },
      });

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'VERIFIED_PENDING_CYCLE_PROOF');
      assert.equal(result.isReadyForSettlement, false);
      assert.equal(result.subscriptionProof?.planCode, 'PLN_starter_checkout_authoritative');
      assert.equal(result.transactionProof?.providerCustomerId, 'CUS_test_cust_456');
    });

    it('fails closed before gateway calls when plan code is Rota enum and no checkout providerPlanCode exists', async () => {
      const db = createMockDatabase({
        subscriptions: [
          createValidLocalSubscription({
            currentPlan: { code: 'STARTER' },
            periods: [
              {
                sequence: 1,
                planCodeSnapshot: 'STARTER',
                totalAmountCents: 2000,
              },
            ],
            invoices: [],
          }),
        ],
      });
      const gateway = new TestRenewalGateway();

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Cannot unambiguously determine expected provider plan code/);
      assert.equal(gateway.fetchSubscriptionCallCount, 0);
      assert.equal(gateway.verifyTransactionCallCount, 0);
    });

    it('fails closed before gateway calls when multiple conflicting checkout plan codes exist', async () => {
      const db = createMockDatabase({
        subscriptions: [
          createValidLocalSubscription({
            invoices: [
              {
                paymentAttempts: [
                  {
                    idempotencyRecord: {
                      responseBody: {
                        recurring: true,
                        providerPlanCode: 'PLN_plan_variant_a',
                        amountCents: 2000,
                      },
                    },
                  },
                  {
                    idempotencyRecord: {
                      responseBody: {
                        recurring: true,
                        providerPlanCode: 'PLN_plan_variant_b',
                        amountCents: 2000,
                      },
                    },
                  },
                ],
              },
            ],
          }),
        ],
      });
      const gateway = new TestRenewalGateway();

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Cannot unambiguously determine expected provider plan code/);
      assert.equal(gateway.fetchSubscriptionCallCount, 0);
    });

    it('fails closed before gateway calls when checkout amount contradicts period amount', async () => {
      const db = createMockDatabase({
        subscriptions: [
          createValidLocalSubscription({
            periods: [
              {
                sequence: 1,
                planCodeSnapshot: 'PLN_starter_monthly',
                totalAmountCents: 3000,
              },
            ],
            invoices: [
              {
                paymentAttempts: [
                  {
                    idempotencyRecord: {
                      responseBody: {
                        recurring: true,
                        providerPlanCode: 'PLN_starter_monthly',
                        amountCents: 2000,
                      },
                    },
                  },
                ],
              },
            ],
          }),
        ],
      });
      const gateway = new TestRenewalGateway();

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /Cannot unambiguously determine expected historical renewal amount/);
      assert.equal(gateway.fetchSubscriptionCallCount, 0);
    });

    it('verifies valid matching identities successfully with mandatory transaction providerCustomerId', async () => {
      const db = createMockDatabase({
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const verifier = new PaystackRenewalVerifier(db, gateway);
      const hint = createValidRenewalHint();

      const result = await verifier.verifyRenewal(hint);
      assert.equal(result.outcome, 'VERIFIED_PENDING_CYCLE_PROOF');
      assert.equal(result.isReadyForSettlement, false);
      assert.equal(result.subscriptionProof?.providerCustomerId, 'CUS_test_cust_456');
      assert.equal(result.transactionProof?.providerCustomerId, 'CUS_test_cust_456');
      assert.equal(gateway.fetchSubscriptionCallCount, 1);
      assert.equal(gateway.verifyTransactionCallCount, 1);
    });
  });
});
