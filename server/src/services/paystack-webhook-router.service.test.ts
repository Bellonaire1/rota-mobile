import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingPaymentAttemptStatus,
  BillingSubscriptionStatus,
} from '@prisma/client';
import {
  PaystackWebhookRouter,
  PAYSTACK_PROVIDER,
  CHARGE_SUCCESS_EVENT,
  SUBSCRIPTION_CREATE_EVENT,
  INVOICE_UPDATE_EVENT,
  INVOICE_PAYMENT_FAILED_EVENT,
} from './paystack-webhook-router.service';

interface MockDatabaseState {
  paymentAttempts: Map<string, any>;
  subscriptions: Map<string, any>;
  ledgerTransactions: Map<string, any>;
}

const createMockDatabase = (state: MockDatabaseState) => ({
  billingPaymentAttempt: {
    findUnique: async (args: { where: { providerReference?: string; providerPaymentId?: string } }) => {
      if (args.where.providerReference) {
        return state.paymentAttempts.get(args.where.providerReference) ?? null;
      }
      return null;
    },
  },
  billingSubscription: {
    findUnique: async (args: { where: { providerSubscriptionId?: string; providerCustomerId?: string } }) => {
      if (args.where.providerSubscriptionId) {
        for (const sub of state.subscriptions.values()) {
          if (sub.providerSubscriptionId === args.where.providerSubscriptionId) return sub;
        }
      }
      if (args.where.providerCustomerId) {
        for (const sub of state.subscriptions.values()) {
          if (sub.providerCustomerId === args.where.providerCustomerId) return sub;
        }
      }
      return null;
    },
  },
  billingLedgerTransaction: {
    findUnique: async (args: { where: { externalReference?: string } }) => {
      if (args.where.externalReference) {
        return state.ledgerTransactions.get(args.where.externalReference) ?? null;
      }
      return null;
    },
  },
});

describe('PaystackWebhookRouter Classification', () => {
  it('1. Correctly classifies legitimate checkout charge.success (one-off checkout)', async () => {
    const reference = 'ref_checkout_one_off_123';
    const subscriptionId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const teamId = randomUUID();

    const mockAttempt = {
      id: attemptId,
      invoiceId,
      providerReference: reference,
      amountCents: 2_000,
      status: BillingPaymentAttemptStatus.PENDING,
      idempotencyRecord: {
        scope: `team-billing-checkout:${teamId}`,
        responseBody: { recurring: false, planCode: 'STARTER', amountCents: 2_000 },
      },
      invoice: {
        id: invoiceId,
        subscriptionId,
        status: BillingInvoiceStatus.DRAFT,
      },
    };

    const state: MockDatabaseState = {
      paymentAttempts: new Map([[reference, mockAttempt]]),
      subscriptions: new Map(),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: CHARGE_SUCCESS_EVENT,
      payload: {
        event: 'charge.success',
        data: { reference },
      },
    });

    assert.strictEqual(result.route, 'INITIAL_CHECKOUT_RECONCILIATION');
    if (result.route === 'INITIAL_CHECKOUT_RECONCILIATION') {
      assert.strictEqual(result.reference, reference);
      assert.strictEqual(result.paymentAttemptId, attemptId);
      assert.strictEqual(result.subscriptionId, subscriptionId);
      assert.strictEqual(result.isRecurring, false);
    }
  });

  it('2. Correctly classifies legitimate checkout charge.success (recurring checkout)', async () => {
    const reference = 'ref_checkout_recurring_456';
    const subscriptionId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();
    const teamId = randomUUID();

    const mockAttempt = {
      id: attemptId,
      invoiceId,
      providerReference: reference,
      amountCents: 2_000,
      status: BillingPaymentAttemptStatus.PENDING,
      idempotencyRecord: {
        scope: `team-billing-checkout:${teamId}`,
        responseBody: JSON.stringify({ recurring: true, planCode: 'STARTER', amountCents: 2_000 }),
      },
      invoice: {
        id: invoiceId,
        subscriptionId,
        status: BillingInvoiceStatus.DRAFT,
      },
    };

    const state: MockDatabaseState = {
      paymentAttempts: new Map([[reference, mockAttempt]]),
      subscriptions: new Map(),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: CHARGE_SUCCESS_EVENT,
      payload: {
        event: 'charge.success',
        data: { reference },
      },
    });

    assert.strictEqual(result.route, 'INITIAL_CHECKOUT_RECONCILIATION');
    if (result.route === 'INITIAL_CHECKOUT_RECONCILIATION') {
      assert.strictEqual(result.reference, reference);
      assert.strictEqual(result.paymentAttemptId, attemptId);
      assert.strictEqual(result.subscriptionId, subscriptionId);
      assert.strictEqual(result.isRecurring, true);
    }
  });

  it('3. Correctly classifies confirmed renewal payment replay', async () => {
    const reference = 'ref_renewal_settled_789';
    const providerPaymentId = 'tx_paystack_999';
    const subscriptionId = randomUUID();
    const invoiceId = randomUUID();
    const attemptId = randomUUID();

    // Settled renewal attempt (not a checkout scope, SUCCEEDED, PAID, POSTED ledger)
    const mockAttempt = {
      id: attemptId,
      invoiceId,
      providerReference: reference,
      providerPaymentId,
      amountCents: 2_000,
      status: BillingPaymentAttemptStatus.SUCCEEDED,
      idempotencyRecord: null,
      invoice: {
        id: invoiceId,
        subscriptionId,
        status: BillingInvoiceStatus.PAID,
      },
    };

    const ledgerExternalRef = `paystack:payment:${providerPaymentId}`;
    const mockLedger = {
      id: randomUUID(),
      externalReference: ledgerExternalRef,
      status: BillingLedgerTransactionStatus.POSTED,
    };

    const state: MockDatabaseState = {
      paymentAttempts: new Map([[reference, mockAttempt]]),
      subscriptions: new Map(),
      ledgerTransactions: new Map([[ledgerExternalRef, mockLedger]]),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: CHARGE_SUCCESS_EVENT,
      payload: {
        event: 'charge.success',
        data: { reference },
      },
    });

    assert.strictEqual(result.route, 'RENEWAL_PAYMENT_REPLAY');
    if (result.route === 'RENEWAL_PAYMENT_REPLAY') {
      assert.strictEqual(result.reference, reference);
      assert.strictEqual(result.paymentAttemptId, attemptId);
      assert.strictEqual(result.subscriptionId, subscriptionId);
      assert.strictEqual(result.invoiceId, invoiceId);
    }
  });

  it('4. Correctly classifies unmatched / ambiguous charge.success without failing closed permanently', async () => {
    const reference = 'ref_unknown_provider_charge_000';
    const state: MockDatabaseState = {
      paymentAttempts: new Map(),
      subscriptions: new Map(),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: CHARGE_SUCCESS_EVENT,
      payload: {
        event: 'charge.success',
        data: {
          reference,
          // Even with subscription metadata hints, must NOT infer renewal identity without stored linkage
          subscription: { subscription_code: 'SUB_unconfirmed_123' },
          metadata: { subscriptionId: 'sub_fake_123' },
        },
      },
    });

    assert.strictEqual(result.route, 'UNRESOLVED_CHARGE_AMBIGUOUS');
    if (result.route === 'UNRESOLVED_CHARGE_AMBIGUOUS') {
      assert.strictEqual(result.reference, reference);
      assert.match(result.reason, /No stored checkout attempt or confirmed renewal/i);
    }
  });

  it('5. Correctly classifies subscription.create with known linkage', async () => {
    const subscriptionCode = 'SUB_linkage_test_111';
    const customerCode = 'CUS_linkage_test_222';
    const subscriptionId = randomUUID();

    const mockSub = {
      id: subscriptionId,
      providerSubscriptionId: null,
      providerCustomerId: customerCode,
      status: BillingSubscriptionStatus.PENDING_CHECKOUT,
    };

    const state: MockDatabaseState = {
      paymentAttempts: new Map(),
      subscriptions: new Map([[subscriptionId, mockSub]]),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: SUBSCRIPTION_CREATE_EVENT,
      payload: {
        event: 'subscription.create',
        data: {
          subscription_code: subscriptionCode,
          customer: { customer_code: customerCode },
        },
      },
    });

    assert.strictEqual(result.route, 'SUBSCRIPTION_CREATE_LINKAGE');
    if (result.route === 'SUBSCRIPTION_CREATE_LINKAGE') {
      assert.strictEqual(result.subscriptionCode, subscriptionCode);
      assert.strictEqual(result.customerCode, customerCode);
      assert.strictEqual(result.localSubscriptionId, subscriptionId);
    }
  });

  it('6. Correctly classifies subscription.create with unrecognized customer/subscription', async () => {
    const subscriptionCode = 'SUB_unknown_333';
    const customerCode = 'CUS_unknown_444';
    const state: MockDatabaseState = {
      paymentAttempts: new Map(),
      subscriptions: new Map(),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: SUBSCRIPTION_CREATE_EVENT,
      payload: {
        event: 'subscription.create',
        data: {
          subscription_code: subscriptionCode,
          customer: { customer_code: customerCode },
        },
      },
    });

    assert.strictEqual(result.route, 'SUBSCRIPTION_CREATE_UNRECOGNIZED');
    if (result.route === 'SUBSCRIPTION_CREATE_UNRECOGNIZED') {
      assert.strictEqual(result.subscriptionCode, subscriptionCode);
      assert.strictEqual(result.customerCode, customerCode);
      assert.match(result.reason, /No stored subscription matches/i);
    }
  });

  it('7. Correctly classifies invoice.update (paid candidate)', async () => {
    const subscriptionCode = 'SUB_invoice_test_555';
    const invoiceCode = 'INV_invoice_test_666';
    const subscriptionId = randomUUID();

    const mockSub = {
      id: subscriptionId,
      providerSubscriptionId: subscriptionCode,
      status: BillingSubscriptionStatus.ACTIVE,
    };

    const state: MockDatabaseState = {
      paymentAttempts: new Map(),
      subscriptions: new Map([[subscriptionId, mockSub]]),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: INVOICE_UPDATE_EVENT,
      payload: {
        event: 'invoice.update',
        data: {
          subscription: { subscription_code: subscriptionCode },
          invoice_code: invoiceCode,
          paid: true,
          status: 'success',
          transaction: { reference: 'ref_tx_777' },
        },
      },
    });

    assert.strictEqual(result.route, 'RENEWAL_INVOICE_UPDATE');
    if (result.route === 'RENEWAL_INVOICE_UPDATE') {
      assert.strictEqual(result.subscriptionCode, subscriptionCode);
      assert.strictEqual(result.invoiceCode, invoiceCode);
      assert.strictEqual(result.transactionReference, 'ref_tx_777');
      assert.strictEqual(result.isPaid, true);
      assert.strictEqual(result.localSubscriptionId, subscriptionId);
    }
  });

  it('8. Correctly classifies invoice.update (unpaid status)', async () => {
    const subscriptionCode = 'SUB_invoice_unpaid_888';
    const invoiceCode = 'INV_invoice_unpaid_999';

    const state: MockDatabaseState = {
      paymentAttempts: new Map(),
      subscriptions: new Map(),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: INVOICE_UPDATE_EVENT,
      payload: {
        event: 'invoice.update',
        data: {
          subscription_code: subscriptionCode,
          invoice_code: invoiceCode,
          paid: false,
          status: 'pending',
        },
      },
    });

    assert.strictEqual(result.route, 'RENEWAL_INVOICE_UPDATE');
    if (result.route === 'RENEWAL_INVOICE_UPDATE') {
      assert.strictEqual(result.isPaid, false);
    }
  });

  it('9. Correctly classifies invoice.payment_failed', async () => {
    const subscriptionCode = 'SUB_failed_cycle_111';
    const customerCode = 'CUS_failed_cycle_222';
    const invoiceCode = 'INV_failed_cycle_333';
    const subscriptionId = randomUUID();

    const mockSub = {
      id: subscriptionId,
      providerSubscriptionId: subscriptionCode,
      status: BillingSubscriptionStatus.ACTIVE,
    };

    const state: MockDatabaseState = {
      paymentAttempts: new Map(),
      subscriptions: new Map([[subscriptionId, mockSub]]),
      ledgerTransactions: new Map(),
    };

    const router = new PaystackWebhookRouter(createMockDatabase(state));
    const result = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: INVOICE_PAYMENT_FAILED_EVENT,
      payload: {
        event: 'invoice.payment_failed',
        data: {
          subscription: { subscription_code: subscriptionCode },
          customer: { customer_code: customerCode },
          invoice_code: invoiceCode,
        },
      },
    });

    assert.strictEqual(result.route, 'RENEWAL_PAYMENT_FAILED');
    if (result.route === 'RENEWAL_PAYMENT_FAILED') {
      assert.strictEqual(result.subscriptionCode, subscriptionCode);
      assert.strictEqual(result.customerCode, customerCode);
      assert.strictEqual(result.invoiceCode, invoiceCode);
      assert.strictEqual(result.localSubscriptionId, subscriptionId);
    }
  });

  it('10. Rejects unsupported event types and foreign providers', async () => {
    const router = new PaystackWebhookRouter(createMockDatabase({
      paymentAttempts: new Map(),
      subscriptions: new Map(),
      ledgerTransactions: new Map(),
    }));

    // Unsupported event type
    const unsupportedResult = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: 'transfer.success',
      payload: { event: 'transfer.success', data: {} },
    });
    assert.strictEqual(unsupportedResult.route, 'UNSUPPORTED_EVENT_TYPE');

    // Unsupported provider
    const foreignProviderResult = await router.classify({
      id: randomUUID(),
      provider: 'stripe',
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: {} },
    });
    assert.strictEqual(foreignProviderResult.route, 'UNSUPPORTED_EVENT_TYPE');
  });

  it('11. Fails closed on malformed payloads and missing references', async () => {
    const router = new PaystackWebhookRouter(createMockDatabase({
      paymentAttempts: new Map(),
      subscriptions: new Map(),
      ledgerTransactions: new Map(),
    }));

    // Missing payload data
    const noData = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: CHARGE_SUCCESS_EVENT,
      payload: { event: 'charge.success' },
    });
    assert.strictEqual(noData.route, 'MALFORMED_EVENT_PAYLOAD');

    // Missing reference string in charge.success
    const emptyRef = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: CHARGE_SUCCESS_EVENT,
      payload: { event: 'charge.success', data: { reference: '   ' } },
    });
    assert.strictEqual(emptyRef.route, 'MALFORMED_EVENT_PAYLOAD');

    // Missing subscription_code in invoice.update
    const noSubInvoice = await router.classify({
      id: randomUUID(),
      provider: PAYSTACK_PROVIDER,
      eventType: INVOICE_UPDATE_EVENT,
      payload: { event: 'invoice.update', data: { invoice_code: 'INV_123' } },
    });
    assert.strictEqual(noSubInvoice.route, 'MALFORMED_EVENT_PAYLOAD');
  });
});
