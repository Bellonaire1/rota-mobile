import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BillingSubscriptionStatus, BillingWebhookEventStatus } from '@prisma/client';
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
import {
  PaystackAuthenticatedRenewalEvidenceService,
  type RenewalEvidenceDatabase,
} from './paystack-renewal-evidence.service';

class TestRenewalGateway implements PaymentGateway {
  private subscriptions = new Map<string, VerifiedSubscription | PaymentGatewayError | null>();
  private transactions = new Map<string, VerifiedPayment | PaymentGatewayError>();

  setSubscription(code: string, result: VerifiedSubscription | PaymentGatewayError | null): void {
    this.subscriptions.set(code, result);
  }

  setTransaction(reference: string, result: VerifiedPayment | PaymentGatewayError): void {
    this.transactions.set(reference, result);
  }

  async fetchSubscriptionByCode(input: FetchSubscriptionByCodeInput): Promise<VerifiedSubscription | null> {
    if (!this.subscriptions.has(input.subscriptionCode)) {
      return null;
    }
    const res = this.subscriptions.get(input.subscriptionCode);
    if (res instanceof PaymentGatewayError) throw res;
    return res ?? null;
  }

  async verifyTransaction(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    if (!this.transactions.has(input.reference)) {
      throw new PaymentGatewayError('PROVIDER_FAILURE', `Transaction ${input.reference} not found`);
    }
    const res = this.transactions.get(input.reference);
    if (res instanceof PaymentGatewayError) throw res;
    return res!;
  }

  async initializeTransaction(_input: InitializePaymentInput): Promise<PaymentInitialization> {
    throw new Error('initializeTransaction not used in renewal evidence verification');
  }

  async createPlan(_input: CreatePlanInput): Promise<ProviderPlan> {
    throw new Error('createPlan not used in renewal evidence verification');
  }

  async fetchPlanByCode(_input: FetchPlanByCodeInput): Promise<ProviderPlan | null> {
    throw new Error('fetchPlanByCode not used in renewal evidence verification');
  }
}

interface MockDatabaseState {
  webhookEvents?: any[];
  subscriptions?: any[];
  invoices?: any[];
  paymentAttempts?: any[];
}

const createMockDatabase = (state: MockDatabaseState = {}): RenewalEvidenceDatabase => {
  const webhookEvents = state.webhookEvents ?? [];
  const subscriptions = state.subscriptions ?? [];
  const invoices = state.invoices ?? [];
  const paymentAttempts = state.paymentAttempts ?? [];

  return {
    billingWebhookEvent: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const found = webhookEvents.find((evt) => evt.id === where.id);
        return found ? structuredClone(found) : null;
      },
    },
    billingSubscription: {
      findUnique: async ({ where }: { where: { providerSubscriptionId?: string; id?: string } }) => {
        const found = subscriptions.find((s) =>
          where.providerSubscriptionId
            ? s.providerSubscriptionId === where.providerSubscriptionId
            : s.id === where.id
        );
        return found ? structuredClone(found) : null;
      },
    },
    billingInvoice: {
      findUnique: async ({ where }: { where: { providerInvoiceId: string } }) => {
        const found = invoices.find((inv) => inv.providerInvoiceId === where.providerInvoiceId);
        return found ? structuredClone(found) : null;
      },
    },
    billingPaymentAttempt: {
      findUnique: async ({ where }: { where: { providerPaymentId: string } }) => {
        const found = paymentAttempts.find((att) => att.providerPaymentId === where.providerPaymentId);
        return found ? structuredClone(found) : null;
      },
    },
  } as unknown as RenewalEvidenceDatabase;
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

const createValidWebhookEvent = (overrides: Record<string, any> = {}): Record<string, any> => ({
  id: 'webhook_evt_001',
  provider: 'paystack',
  eventType: 'invoice.update',
  signatureVerifiedAt: new Date('2026-11-01T00:05:00.000Z'),
  status: BillingWebhookEventStatus.RECEIVED,
  payload: {
    event: 'invoice.update',
    data: {
      id: 43258791,
      invoice_code: 'INV_2026_cycle_02',
      customer: {
        customer_code: 'CUS_test_cust_456',
        email: 'billing@example.com',
      },
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
      status: 'paid',
      paid: true,
      paid_at: '2026-11-01T00:05:00.000Z',
      amount: 2000,
      currency: 'USD',
      period_start: '2026-11-01T00:00:00.000Z',
      period_end: '2026-12-01T00:00:00.000Z',
      transaction: {
        id: 987654321,
        status: 'success',
        reference: 'T_ren_123456789',
        amount: 2000,
        currency: 'USD',
        paid_at: '2026-11-01T00:05:00.000Z',
        customer: {
          customer_code: 'CUS_test_cust_456',
        },
      },
    },
  },
  ...overrides,
});

describe('PaystackAuthenticatedRenewalEvidenceService', () => {
  describe('successful authenticated evidence generation', () => {
    it('produces authenticated renewal evidence correlating webhook and verified gateway lookups', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'AUTHENTICATED_EVIDENCE_PRODUCED');
      assert.equal(result.isReadyForSettlement, false);

      // Authenticated Webhook Association
      assert.deepEqual(result.webhookAssociation, {
        webhookEventId: 'webhook_evt_001',
        signatureVerifiedAt: new Date('2026-11-01T00:05:00.000Z'),
        eventType: 'invoice.update',
        invoiceCode: 'INV_2026_cycle_02',
        invoiceId: '43258791',
        subscriptionCode: 'SUB_test_sub_123',
        transactionReference: 'T_ren_123456789',
        customerCode: 'CUS_test_cust_456',
        amountCents: 2000,
        currency: 'USD',
        periodStart: new Date('2026-11-01T00:00:00.000Z'),
        periodEnd: new Date('2026-12-01T00:00:00.000Z'),
        invoicePaidAt: new Date('2026-11-01T00:05:00.000Z'),
      });

      // Subscription Proof
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

      // Transaction Proof
      assert.deepEqual(result.transactionProof, {
        reference: 'T_ren_123456789',
        providerTransactionId: '987654321',
        providerCustomerId: 'CUS_test_cust_456',
        amountCents: 2000,
        currency: 'USD',
        status: 'success',
      });

      // Unresolved facts explicitly documented
      assert.ok(result.unresolvedFacts.length >= 2);
      assert.match(result.unresolvedFacts[0]!, /UNRESOLVED_INVOICE_OWNERSHIP/);
      assert.match(result.unresolvedFacts[1]!, /UNRESOLVED_CYCLE_ENTITLEMENT/);
    });
  });

  describe('signature provenance enforcement', () => {
    it('fails closed when webhook event is not found in database', async () => {
      const db = createMockDatabase({ webhookEvents: [] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'missing_evt_id' });
      assert.equal(result.outcome, 'MISSING_SIGNATURE_PROVENANCE');
      assert.equal(result.isReadyForSettlement, false);
      assert.match(result.error ?? '', /was not found in BillingWebhookEvent/);
    });

    it('fails closed when signatureVerifiedAt is missing', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent({ signatureVerifiedAt: null })],
      });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'MISSING_SIGNATURE_PROVENANCE');
      assert.match(result.error ?? '', /lacks verified signature provenance/);
    });

    it('fails closed when provider is not paystack', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent({ provider: 'stripe' })],
      });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'MISSING_SIGNATURE_PROVENANCE');
      assert.match(result.error ?? '', /lacks verified signature provenance/);
    });

    it('fails closed when webhookEventId is empty or not a string', async () => {
      const db = createMockDatabase();
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: '' });
      assert.equal(result.outcome, 'MISSING_SIGNATURE_PROVENANCE');
    });
  });

  describe('event type validation', () => {
    it('rejects charge.success events as unsupported for authenticated renewal cycle evidence', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent({ eventType: 'charge.success' })],
      });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'UNSUPPORTED_EVENT_TYPE');
      assert.match(result.error ?? '', /Only invoice\.update provides authenticated cycle evidence/);
    });

    it('rejects invoice.create events as unsupported', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent({ eventType: 'invoice.create' })],
      });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'UNSUPPORTED_EVENT_TYPE');
    });

    it('rejects subscription.create events as unsupported', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent({ eventType: 'subscription.create' })],
      });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'UNSUPPORTED_EVENT_TYPE');
    });
  });

  describe('malformed invoice evidence rejection', () => {
    it('rejects payload missing invoice_code', async () => {
      const validEvt = createValidWebhookEvent();
      delete validEvt.payload.data.invoice_code;

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'MALFORMED_INVOICE_EVIDENCE');
      assert.match(result.error ?? '', /lacks a provider invoice code/);
    });

    it('rejects malformed invoice_code format', async () => {
      const validEvt = createValidWebhookEvent();
      validEvt.payload.data.invoice_code = 'BAD_PREFIX_123';

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'MALFORMED_INVOICE_EVIDENCE');
    });

    it('rejects payload missing transaction reference', async () => {
      const validEvt = createValidWebhookEvent();
      delete validEvt.payload.data.transaction.reference;

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'MALFORMED_INVOICE_EVIDENCE');
      assert.match(result.error ?? '', /lacks a candidate transaction reference/);
    });

    it('rejects payload missing subscription code', async () => {
      const validEvt = createValidWebhookEvent();
      delete validEvt.payload.data.subscription.subscription_code;

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'MALFORMED_INVOICE_EVIDENCE');
      assert.match(result.error ?? '', /lacks a provider subscription code/);
    });

    it('rejects non-USD currency as DEFINITIVE_CONTRADICTION', async () => {
      const validEvt = createValidWebhookEvent();
      validEvt.payload.data.currency = 'NGN';
      validEvt.payload.data.subscription.plan.currency = 'NGN';

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /expected USD/);
    });
  });

  describe('invoice state validation (unambiguous success required)', () => {
    it('fails closed when invoice paid flag is false', async () => {
      const validEvt = createValidWebhookEvent();
      validEvt.payload.data.paid = false;
      delete validEvt.payload.data.paid_at;

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'INCOMPLETE_INVOICE_STATE');
      assert.match(result.error ?? '', /paid=false/);
    });

    it('fails closed when invoice status is pending', async () => {
      const validEvt = createValidWebhookEvent();
      validEvt.payload.data.status = 'pending';

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'INCOMPLETE_INVOICE_STATE');
      assert.match(result.error ?? '', /expected "paid" or "success"/);
    });

    it('fails closed when candidate transaction status in payload is not success', async () => {
      const validEvt = createValidWebhookEvent();
      validEvt.payload.data.transaction.status = 'failed';

      const db = createMockDatabase({ webhookEvents: [validEvt] });
      const gateway = new TestRenewalGateway();
      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);

      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });
      assert.equal(result.outcome, 'INCOMPLETE_INVOICE_STATE');
      assert.match(result.error ?? '', /expected "success"/);
    });
  });

  describe('conflicts and replays', () => {
    it('returns CONFLICT when provider invoice code is bound to another subscription', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
        subscriptions: [createValidLocalSubscription()],
        invoices: [
          {
            id: 'inv_other_999',
            subscriptionId: 'sub_foreign_other_team',
            providerInvoiceId: 'INV_2026_cycle_02',
          },
        ],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'CONFLICT');
      assert.match(result.error ?? '', /already bound to another subscription/);
    });

    it('returns CONFLICT when candidate transaction ID is bound to another subscription', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
        subscriptions: [createValidLocalSubscription()],
        paymentAttempts: [
          {
            id: 'att_other_999',
            providerPaymentId: '987654321',
            invoice: {
              id: 'inv_other_999',
              subscriptionId: 'sub_foreign_other_team',
            },
          },
        ],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'CONFLICT');
      assert.match(result.error ?? '', /already linked to another subscription/);
    });

    it('flags isReplayCandidate when invoice ID was already recorded on the SAME subscription', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
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

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'AUTHENTICATED_EVIDENCE_PRODUCED');
      assert.equal(result.isReplayCandidate, true);
      assert.equal(result.isReadyForSettlement, false);
    });

    it('flags isReplayCandidate when transaction ID was already recorded on the SAME subscription', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
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

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'AUTHENTICATED_EVIDENCE_PRODUCED');
      assert.equal(result.isReplayCandidate, true);
      assert.equal(result.isReadyForSettlement, false);
    });
  });

  describe('definitive contradictions and provider outages', () => {
    it('returns DEFINITIVE_CONTRADICTION when provider subscription customer mismatches', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        createValidVerifiedSubscription({ customerCode: 'CUS_intruder_999' })
      );
      gateway.setTransaction('T_ren_123456789', createValidVerifiedPayment());

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /do not match expected local subscription identities/);
    });

    it('returns DEFINITIVE_CONTRADICTION when transaction amount mismatches', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction(
        'T_ren_123456789',
        createValidVerifiedPayment({ amountCents: 5000 })
      );

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'DEFINITIVE_CONTRADICTION');
      assert.match(result.error ?? '', /Verified transaction attributes do not match/);
    });

    it('returns PROVIDER_OUTAGE on subscription lookup timeout', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription(
        'SUB_test_sub_123',
        new PaymentGatewayError('TIMEOUT', 'Subscription request timed out')
      );

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'PROVIDER_OUTAGE');
      assert.equal(result.isReadyForSettlement, false);
    });

    it('returns PROVIDER_OUTAGE on transaction verification network failure', async () => {
      const db = createMockDatabase({
        webhookEvents: [createValidWebhookEvent()],
        subscriptions: [createValidLocalSubscription()],
      });
      const gateway = new TestRenewalGateway();
      gateway.setSubscription('SUB_test_sub_123', createValidVerifiedSubscription());
      gateway.setTransaction(
        'T_ren_123456789',
        new PaymentGatewayError('NETWORK', 'Network connection failed')
      );

      const service = new PaystackAuthenticatedRenewalEvidenceService(db, gateway);
      const result = await service.collectRenewalEvidence({ webhookEventId: 'webhook_evt_001' });

      assert.equal(result.outcome, 'PROVIDER_OUTAGE');
      assert.equal(result.isReadyForSettlement, false);
    });
  });
});
