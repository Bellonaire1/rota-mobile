process.env.JWT_ACCESS_SECRET =
  process.env.JWT_ACCESS_SECRET || 'test-jwt-access-secret-at-least-32-chars-long';

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingLedgerTransactionType,
  BillingPaymentAttemptStatus,
  BillingPeriodStatus,
  BillingSubscriptionStatus,
  BillingWebhookEventStatus,
  Prisma,
} from '@prisma/client';
import {
  PaymentGatewayError,
  type CreatePlanInput,
  type FetchPlanByCodeInput,
  type FetchSubscriptionByCodeInput,
  type InitializePaymentInput,
  type PaymentGateway,
  type PaymentInitialization,
  type PaystackCurrency,
  type ProviderPlan,
  type VerifiedPayment,
  type VerifiedSubscription,
  type VerifyPaymentInput,
} from '../billing/payments';
import { RENEWAL_BILLING_POLICIES } from '../billing/billing-calendar';
import {
  PermanentWebhookError,
  RetryableWebhookError,
} from '../jobs/webhook-event-processor';
import {
  WebhookWorker,
  type WebhookWorkerConfig,
} from '../jobs/webhook-worker';
import {
  WebhookEventQueue,
  type WebhookWorkItem,
} from '../jobs/webhook-event-queue';
import {
  PaystackWebhookEventProcessor,
  PAYSTACK_PROVIDER,
} from './paystack-webhook-processor.service';
import {
  CASH_ACCOUNT,
  ACCOUNTS_RECEIVABLE_ACCOUNT,
} from './paystack-renewal-settlement.service';
import { DEFAULT_UNRESOLVED_FACTS } from './paystack-renewal-evidence.service';

interface MockDatabaseState {
  events: Array<{
    id: string;
    provider: string;
    eventType: string;
    payload: any;
    status: BillingWebhookEventStatus;
    attemptCount: number;
    processingLeaseToken: string | null;
    processingLeaseUntil: Date | null;
    lastError: string | null;
    processedAt: Date | null;
    receivedAt: Date;
    nextAttemptAt: Date;
    signatureVerifiedAt?: Date | null;
  }>;
  subscriptions: Array<{
    id: string;
    teamId: string;
    planId: string;
    priceId: string;
    status: BillingSubscriptionStatus;
    provider: string | null;
    providerCustomerId: string | null;
    providerSubscriptionId: string | null;
    currency: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    gracePeriodEndsAt: Date | null;
    version: number;
    currentPlan: { id: string; code: string };
    currentPrice: {
      id: string;
      planId: string;
      monthlyPriceCents: number;
      includedStaffSeats: number;
      extraStaffSeatPriceCents: number;
      currency: string;
    };
  }>;
  invoices: Array<any>;
  paymentAttempts: Array<any>;
  periods: Array<any>;
  ledgerTransactions: Array<any>;
  ledgerEntries: Array<any>;
  idempotencyKeys: Array<any>;
}

const createMockDatabase = (state: MockDatabaseState) => {
  const transactionClient = {
    $queryRaw: async (query: any, ...values: any[]) => {
      return [];
    },
    billingWebhookEvent: {
      findUnique: async (args: any) => {
        return state.events.find((e) => e.id === args.where?.id) ?? null;
      },
      updateMany: async (args: any) => {
        const matching = state.events.filter((e) => {
          if (args.where?.id && e.id !== args.where.id) return false;
          if (args.where?.status && e.status !== args.where.status) return false;
          if (
            args.where?.processingLeaseToken &&
            e.processingLeaseToken !== args.where.processingLeaseToken
          )
            return false;
          if (args.where?.processingLeaseUntil?.gt) {
            if (!e.processingLeaseUntil || e.processingLeaseUntil <= args.where.processingLeaseUntil.gt) {
              return false;
            }
          }
          return true;
        });

        for (const item of matching) {
          if (args.data?.status !== undefined) item.status = args.data.status;
          if (args.data?.processedAt !== undefined) item.processedAt = args.data.processedAt;
          if (args.data?.processingLeaseUntil !== undefined)
            item.processingLeaseUntil = args.data.processingLeaseUntil;
          if (args.data?.processingLeaseToken !== undefined)
            item.processingLeaseToken = args.data.processingLeaseToken;
          if (args.data?.lastError !== undefined) item.lastError = args.data.lastError;
          if (args.data?.nextAttemptAt !== undefined) item.nextAttemptAt = args.data.nextAttemptAt;
        }

        return { count: matching.length };
      },
      update: async (args: any) => {
        const item = state.events.find((e) => e.id === args.where?.id);
        if (item) Object.assign(item, args.data);
        return item;
      },
    },
    billingSubscription: {
      findUnique: async (args: any) => {
        if (args.where?.id) {
          return state.subscriptions.find((s) => s.id === args.where.id) ?? null;
        }
        if (args.where?.providerCustomerId) {
          const sub = state.subscriptions.find((s) => s.providerCustomerId === args.where.providerCustomerId);
          if (sub) {
            const invoices = state.invoices
              .filter((i) => i.subscriptionId === sub.id)
              .map((inv) => ({
                ...inv,
                paymentAttempts: state.paymentAttempts
                  .filter((a) => a.invoiceId === inv.id)
                  .map((att) => ({
                    ...att,
                    idempotencyRecord: state.idempotencyKeys.find((k) => k.id === att.idempotencyKeyId) ?? null,
                  })),
              }));
            return { ...sub, invoices };
          }
        }
        if (args.where?.providerSubscriptionId) {
          const sub = state.subscriptions.find((s) => s.providerSubscriptionId === args.where.providerSubscriptionId);
          if (sub) {
            const invoices = state.invoices
              .filter((i) => i.subscriptionId === sub.id)
              .map((inv) => ({
                ...inv,
                paymentAttempts: state.paymentAttempts
                  .filter((a) => a.invoiceId === inv.id)
                  .map((att) => ({
                    ...att,
                    idempotencyRecord: state.idempotencyKeys.find((k) => k.id === att.idempotencyKeyId) ?? null,
                  })),
              }));
            return { ...sub, invoices };
          }
        }
        return null;
      },
      findFirst: async (args: any) => {
        return state.subscriptions[0] ?? null;
      },
      update: async (args: any) => {
        const sub = state.subscriptions.find((s) => s.id === args.where?.id);
        if (sub) {
          if (args.data?.version?.increment) sub.version += args.data.version.increment;
          const { version, ...rest } = args.data;
          Object.assign(sub, rest);
        }
        return sub;
      },
    },
    billingInvoice: {
      findUnique: async (args: any) => {
        if (args.where?.id) {
          return state.invoices.find((i) => i.id === args.where.id) ?? null;
        }
        if (args.where?.providerInvoiceId) {
          const inv = state.invoices.find((i) => i.providerInvoiceId === args.where.providerInvoiceId);
          if (inv) {
            return {
              ...inv,
              paymentAttempts: state.paymentAttempts.filter((a) => a.invoiceId === inv.id),
            };
          }
        }
        return null;
      },
      update: async (args: any) => {
        const inv = state.invoices.find((i) => i.id === args.where?.id);
        if (inv) Object.assign(inv, args.data);
        return inv;
      },
      create: async (args: any) => {
        const invoice = { id: `invoice_${randomUUID()}`, ...args.data };
        state.invoices.push(invoice);
        return invoice;
      },
    },
    billingPaymentAttempt: {
      findUnique: async (args: any) => {
        if (args.where?.id) {
          const att = state.paymentAttempts.find((a) => a.id === args.where.id);
          if (att) {
            const inv = state.invoices.find((i) => i.id === att.invoiceId);
            const sub = inv ? state.subscriptions.find((s) => s.id === inv.subscriptionId) : null;
            const idempotency = state.idempotencyKeys.find((k) => k.id === att.idempotencyKeyId) ?? null;
            return {
              ...att,
              invoice: inv ? { ...inv, subscription: sub } : null,
              idempotencyRecord: idempotency,
            };
          }
        }
        if (args.where?.providerReference) {
          const att = state.paymentAttempts.find((a) => a.providerReference === args.where.providerReference);
          if (att) {
            const inv = state.invoices.find((i) => i.id === att.invoiceId);
            const sub = inv ? state.subscriptions.find((s) => s.id === inv.subscriptionId) : null;
            const idempotency = state.idempotencyKeys.find((k) => k.id === att.idempotencyKeyId) ?? null;
            return {
              ...att,
              invoice: inv ? { ...inv, subscription: sub } : null,
              idempotencyRecord: idempotency,
            };
          }
        }
        if (args.where?.providerPaymentId) {
          const att = state.paymentAttempts.find((a) => a.providerPaymentId === args.where.providerPaymentId);
          if (att) {
            const inv = state.invoices.find((i) => i.id === att.invoiceId);
            const sub = inv ? state.subscriptions.find((s) => s.id === inv.subscriptionId) : null;
            return { ...att, invoice: inv ? { ...inv, subscription: sub } : null };
          }
        }
        return null;
      },
      findFirst: async (args: any) => {
        const matching = state.paymentAttempts.filter((a) => {
          if (args?.where?.status && a.status !== args.where.status) return false;
          if (args?.where?.invoice?.subscriptionId) {
            const inv = state.invoices.find((i) => i.id === a.invoiceId);
            if (!inv || inv.subscriptionId !== args.where.invoice.subscriptionId) return false;
          }
          return true;
        });
        const att = matching[0] ?? null;
        if (att) {
          const inv = state.invoices.find((i) => i.id === att.invoiceId);
          const sub = inv ? state.subscriptions.find((s) => s.id === inv.subscriptionId) : null;
          const idempotency = state.idempotencyKeys.find((k) => k.id === att.idempotencyKeyId) ?? null;
          return {
            ...att,
            invoice: inv ? { ...inv, subscription: sub } : null,
            idempotencyRecord: idempotency,
          };
        }
        return null;
      },
      update: async (args: any) => {
        const att = state.paymentAttempts.find((a) => a.id === args.where?.id);
        if (att) Object.assign(att, args.data);
        return att;
      },
      create: async (args: any) => {
        const attempt = { id: `attempt_${randomUUID()}`, ...args.data };
        state.paymentAttempts.push(attempt);
        return attempt;
      },
    },
    billingPeriod: {
      findFirst: async (args: any) => {
        const matching = state.periods.filter((p) => p.subscriptionId === args.where?.subscriptionId);
        if (args.where?.sequence) return matching.find((p) => p.sequence === args.where.sequence) ?? null;
        return matching[matching.length - 1] ?? null;
      },
      create: async (args: any) => {
        const period = { id: `period_${randomUUID()}`, ...args.data };
        state.periods.push(period);
        return period;
      },
    },
    billingLedgerTransaction: {
      findUnique: async (args: any) => {
        return (
          state.ledgerTransactions.find((tx) => tx.externalReference === args.where?.externalReference) ?? null
        );
      },
      create: async (args: any) => {
        const ledger = { id: `ledger_${randomUUID()}`, ...args.data };
        state.ledgerTransactions.push(ledger);
        return ledger;
      },
      update: async (args: any) => {
        const ledger = state.ledgerTransactions.find((tx) => tx.id === args.where?.id);
        if (ledger) Object.assign(ledger, args.data);
        return ledger;
      },
    },
    billingLedgerEntry: {
      createMany: async (args: any) => {
        state.ledgerEntries.push(...args.data);
        return { count: args.data.length };
      },
    },
  };

  const database: any = {
    ...transactionClient,
    $transaction: async <T>(operation: (tx: any) => Promise<T>): Promise<T> => {
      return operation(transactionClient);
    },
  };

  return { database, transactionClient };
};

const createMockQueue = (database: any, state: MockDatabaseState): WebhookEventQueue => {
  const queue = new WebhookEventQueue(database);
  // Override claimOne and countLegacyProcessingEvents for in-memory testing
  queue.countLegacyProcessingEvents = async () => 0;
  queue.claimOne = async (leaseDurationMs: number, provider?: string, eventType?: string, receivedAfter?: Date) => {
    const now = new Date();
    const candidate = state.events.find((e) => {
      const isReceived = e.status === BillingWebhookEventStatus.RECEIVED && e.nextAttemptAt <= now;
      const isExpiredLease =
        e.status === BillingWebhookEventStatus.PROCESSING &&
        e.processingLeaseUntil !== null &&
        e.processingLeaseUntil <= now;
      if (!isReceived && !isExpiredLease) return false;
      if (provider && e.provider !== provider) return false;
      if (eventType && e.eventType !== eventType) return false;
      if (receivedAfter && e.receivedAt < receivedAfter) return false;
      return true;
    });

    if (!candidate) return null;

    const token = randomBytes(32).toString('hex');
    candidate.status = BillingWebhookEventStatus.PROCESSING;
    candidate.attemptCount += 1;
    candidate.processingLeaseToken = token;
    candidate.processingLeaseUntil = new Date(Date.now() + leaseDurationMs);

    return {
      id: candidate.id,
      provider: candidate.provider,
      eventType: candidate.eventType,
      payload: candidate.payload,
      attemptCount: candidate.attemptCount,
      processingLeaseToken: token,
      processingLeaseUntil: candidate.processingLeaseUntil,
    };
  };

  return queue;
};

class MockTestGateway implements PaymentGateway {
  private transactions = new Map<string, VerifiedPayment>();
  private subscriptions = new Map<string, VerifiedSubscription>();

  setTransactionResult(reference: string, result: VerifiedPayment) {
    this.transactions.set(reference, result);
  }

  setSubscriptionResult(code: string, result: VerifiedSubscription) {
    this.subscriptions.set(code, result);
  }

  async initializeTransaction(input: InitializePaymentInput): Promise<PaymentInitialization> {
    return {
      authorizationUrl: `https://checkout.paystack.com/${input.reference}`,
      accessCode: `acc_${input.reference}`,
      reference: input.reference,
    };
  }

  async verifyTransaction(input: VerifyPaymentInput): Promise<VerifiedPayment> {
    const tx = this.transactions.get(input.reference);
    if (!tx) {
      throw new PaymentGatewayError('PROVIDER_FAILURE', `Transaction ${input.reference} not found`);
    }
    return tx;
  }

  async createPlan(input: CreatePlanInput): Promise<ProviderPlan> {
    return {
      providerPlanId: '999',
      planCode: 'PLN_starter_001',
      name: input.name,
      amountCents: input.amountCents,
      currency: input.currency,
      interval: input.interval,
    };
  }

  async fetchPlanByCode(input: FetchPlanByCodeInput): Promise<ProviderPlan | null> {
    return {
      providerPlanId: '999',
      planCode: input.planCode,
      name: input.expectedName,
      amountCents: input.expectedAmountCents,
      currency: input.expectedCurrency,
      interval: input.expectedInterval,
    };
  }

  async fetchSubscriptionByCode(input: FetchSubscriptionByCodeInput): Promise<VerifiedSubscription | null> {
    return this.subscriptions.get(input.subscriptionCode) ?? null;
  }
}

const setupTestEnvironment = (options?: {
  subscriptionStatus?: BillingSubscriptionStatus;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  recurring?: boolean;
}) => {
  const teamId = randomUUID();
  const subscriptionId = randomUUID();
  const planId = randomUUID();
  const priceId = randomUUID();
  const invoiceId = randomUUID();
  const attemptId = randomUUID();
  const idempotencyKeyId = randomUUID();
  const reference = 'ref_checkout_test_001';
  const customerCode = options?.providerCustomerId ?? 'CUS_mock_test_001';
  const subscriptionCode = options?.providerSubscriptionId ?? 'SUB_mock_test_001';
  const planCode = 'STARTER';
  const amountCents = 2_000;

  const state: MockDatabaseState = {
    events: [],
    subscriptions: [
      {
        id: subscriptionId,
        teamId,
        planId,
        priceId,
        status: options?.subscriptionStatus ?? BillingSubscriptionStatus.PENDING_CHECKOUT,
        provider: 'paystack',
        providerCustomerId: options?.providerCustomerId ? customerCode : null,
        providerSubscriptionId: options?.providerSubscriptionId ? subscriptionCode : null,
        currency: 'USD',
        currentPeriodStart: null,
        currentPeriodEnd: null,
        gracePeriodEndsAt: null,
        version: 1,
        currentPlan: { id: planId, code: planCode },
        currentPrice: {
          id: priceId,
          planId,
          monthlyPriceCents: amountCents,
          includedStaffSeats: 5,
          extraStaffSeatPriceCents: 0,
          currency: 'USD',
        },
      },
    ],
    invoices: [
      {
        id: invoiceId,
        subscriptionId,
        status: BillingInvoiceStatus.DRAFT,
        subtotalCents: amountCents,
        totalCents: amountCents,
        amountPaidCents: 0,
        currency: 'USD',
        providerInvoiceId: null,
      },
    ],
    paymentAttempts: [
      {
        id: attemptId,
        invoiceId,
        idempotencyKeyId,
        providerReference: reference,
        providerPaymentId: null,
        status: BillingPaymentAttemptStatus.PENDING,
        amountCents,
      },
    ],
    periods: [],
    ledgerTransactions: [],
    ledgerEntries: [],
    idempotencyKeys: [
      {
        id: idempotencyKeyId,
        teamId,
        scope: `team-billing-checkout:${teamId}`,
        responseBody: {
          subscriptionId,
          invoiceId,
          paymentAttemptId: attemptId,
          providerReference: reference,
          planCode,
          priceId,
          billableStaffSeats: 0,
          amountCents,
          currency: 'USD',
          recurring: options?.recurring ?? false,
          providerPlanCode: 'PLN_starter_001',
        },
      },
    ],
  };

  const { database } = createMockDatabase(state);
  const queue = createMockQueue(database, state);
  const gateway = new MockTestGateway();

  // Configure gateway mock
  gateway.setTransactionResult(reference, {
    reference,
    providerTransactionId: 'tx_paystack_999',
    providerCustomerId: customerCode,
    amountCents,
    currency: 'USD' as PaystackCurrency,
    status: 'success',
  });

  return {
    state,
    database,
    queue,
    gateway,
    reference,
    customerCode,
    subscriptionCode,
    subscriptionId,
    invoiceId,
    attemptId,
    amountCents,
  };
};

const workerTestConfig: WebhookWorkerConfig = {
  provider: PAYSTACK_PROVIDER,
  pollIntervalMs: 1,
  leaseDurationMs: 10_000,
  maxAttempts: 3,
  batchSize: 1,
  retryBaseDelayMs: 50,
  retryMaxDelayMs: 1_000,
  retryJitterRatio: 0,
};

describe('PaystackWebhookEventProcessor & Queue Orchestration', () => {
  it('1. Checkout success: valid charge.success reconciles atomically and acknowledges as PROCESSED', async () => {
    const env = setupTestEnvironment();
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const eventId = 'evt_checkout_success_001';
    env.state.events.push({
      id: eventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: {
        event: 'charge.success',
        data: {
          reference: env.reference,
          status: 'success',
          amount: env.amountCents,
          currency: 'USD',
          customer: { customer_code: env.customerCode },
        },
      },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    const processedCount = await worker.runOnce();
    assert.strictEqual(processedCount, 1);

    const event = env.state.events.find((e) => e.id === eventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.PROCESSED);
    assert.strictEqual(event.lastError, null);
    assert.ok(event.processedAt instanceof Date);

    // Verify financial states
    const attempt = env.state.paymentAttempts.find((a) => a.id === env.attemptId)!;
    assert.strictEqual(attempt.status, BillingPaymentAttemptStatus.SUCCEEDED);
    assert.strictEqual(attempt.providerPaymentId, 'tx_paystack_999');

    const invoice = env.state.invoices.find((i) => i.id === env.invoiceId)!;
    assert.strictEqual(invoice.status, BillingInvoiceStatus.PAID);
    assert.strictEqual(invoice.amountPaidCents, env.amountCents);

    const subscription = env.state.subscriptions.find((s) => s.id === env.subscriptionId)!;
    assert.strictEqual(subscription.status, BillingSubscriptionStatus.ACTIVE);
    assert.strictEqual(subscription.providerCustomerId, env.customerCode);

    // Balanced posted ledger transaction
    assert.strictEqual(env.state.ledgerTransactions.length, 1);
    const ledger = env.state.ledgerTransactions[0];
    assert.strictEqual(ledger.status, BillingLedgerTransactionStatus.POSTED);
    assert.strictEqual(env.state.ledgerEntries.length, 2);
  });

  it('2. Checkout replay: exact replay of already reconciled charge.success acknowledges without duplicate writes', async () => {
    const env = setupTestEnvironment();
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const firstEventId = 'evt_first_checkout_001';
    env.state.events.push({
      id: firstEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: env.reference } },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    await worker.runOnce();
    assert.strictEqual(env.state.events[0].status, BillingWebhookEventStatus.PROCESSED);
    const periodCount = env.state.periods.length;
    const ledgerCount = env.state.ledgerTransactions.length;

    // Second delivery of the identical checkout charge.success
    const replayEventId = 'evt_replay_checkout_002';
    env.state.events.push({
      id: replayEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: env.reference } },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    const secondProcessedCount = await worker.runOnce();
    assert.strictEqual(secondProcessedCount, 1);

    const replayEvent = env.state.events.find((e) => e.id === replayEventId)!;
    assert.strictEqual(replayEvent.status, BillingWebhookEventStatus.PROCESSED);
    assert.strictEqual(env.state.periods.length, periodCount, 'Zero new periods created on replay');
    assert.strictEqual(env.state.ledgerTransactions.length, ledgerCount, 'Zero new ledger rows on replay');
  });

  it('3. Signed renewal invoice: refuses settlement while proof is unresolved, marks event FAILED terminal with zero writes', async () => {
    const env = setupTestEnvironment({
      subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
      providerCustomerId: 'CUS_renewal_001',
      providerSubscriptionId: 'SUB_renewal_001',
      recurring: true,
    });
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const renewalEventId = 'evt_signed_renewal_invoice_001';
    env.state.events.push({
      id: renewalEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'invoice.update',
      payload: {
        event: 'invoice.update',
        data: {
          id: 991823,
          invoice_code: 'INV_renewal_proof_002',
          subscription: {
            subscription_code: env.subscriptionCode,
            status: 'active',
            plan: { plan_code: 'PLN_starter_001' },
            customer: { customer_code: env.customerCode },
          },
          transaction: {
            reference: 'ref_renewal_tx_002',
            id: 88291,
            status: 'success',
          },
          paid: true,
          status: 'success',
          amount: env.amountCents,
          currency: 'USD',
        },
      },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
      signatureVerifiedAt: new Date(),
    });

    // Mock gateway calls for renewal verification
    env.gateway.setSubscriptionResult(env.subscriptionCode, {
      providerSubscriptionId: 'sub_prov_001',
      subscriptionCode: env.subscriptionCode,
      customerCode: env.customerCode,
      planCode: 'PLN_starter_001',
      amountCents: env.amountCents,
      currency: 'USD',
      interval: 'monthly',
      status: 'active',
    });
    env.gateway.setTransactionResult('ref_renewal_tx_002', {
      reference: 'ref_renewal_tx_002',
      providerTransactionId: '88291',
      providerCustomerId: env.customerCode,
      amountCents: env.amountCents,
      currency: 'USD' as PaystackCurrency,
      status: 'success',
    });

    const runCount = await worker.runOnce();
    assert.strictEqual(runCount, 1);

    const event = env.state.events.find((e) => e.id === renewalEventId)!;
    // Must be FAILED (terminal refusal), NOT PROCESSED
    assert.strictEqual(event.status, BillingWebhookEventStatus.FAILED);
    assert.match(event.lastError ?? '', /Renewal settlement refused by proof gate/i);
    assert.match(event.lastError ?? '', /isReadyForSettlement: false/i);

    // Proof gate refusal causes ZERO financial writes
    assert.strictEqual(
      env.state.invoices.filter((i) => i.providerInvoiceId === 'INV_renewal_proof_002').length,
      0,
      'No renewal invoice created'
    );
    assert.strictEqual(
      env.state.paymentAttempts.filter((a) => a.providerReference === 'ref_renewal_tx_002').length,
      0,
      'No renewal payment attempt created'
    );
    assert.strictEqual(env.state.ledgerTransactions.length, 0, 'No renewal ledger transaction created');
  });

  it('4. Malformed charges: rejects missing reference or invalid payload as FAILED terminal', async () => {
    const env = setupTestEnvironment();
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const malformedEventId = 'evt_malformed_001';
    env.state.events.push({
      id: malformedEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { status: 'success' } }, // missing reference
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    await worker.runOnce();

    const event = env.state.events.find((e) => e.id === malformedEventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.FAILED);
    assert.match(event.lastError ?? '', /Malformed webhook payload/i);
  });

  it('5. Ambiguous charges: rejects unknown reference fail-closed as FAILED terminal', async () => {
    const env = setupTestEnvironment();
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const ambiguousEventId = 'evt_ambiguous_001';
    env.state.events.push({
      id: ambiguousEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: 'ref_completely_unknown_999' } },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    await worker.runOnce();

    const event = env.state.events.find((e) => e.id === ambiguousEventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.FAILED);
    assert.match(event.lastError ?? '', /Ambiguous charge event unresolved/i);
    assert.strictEqual(env.state.ledgerTransactions.length, 0);
  });

  it('6. Failed-payment events: non-mutating, zero database writes, marked FAILED terminal', async () => {
    const env = setupTestEnvironment({
      subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
      providerCustomerId: 'CUS_failed_pay_001',
      providerSubscriptionId: 'SUB_failed_pay_001',
      recurring: true,
    });
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const failedPaymentEventId = 'evt_payment_failed_001';
    env.state.events.push({
      id: failedPaymentEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'invoice.payment_failed',
      payload: {
        event: 'invoice.payment_failed',
        data: {
          subscription: { subscription_code: env.subscriptionCode },
          customer: { customer_code: env.customerCode },
          invoice_code: 'INV_failed_001',
        },
      },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    await worker.runOnce();

    const event = env.state.events.find((e) => e.id === failedPaymentEventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.FAILED);
    assert.match(event.lastError ?? '', /dunning policy pending implementation/i);

    // Subscription status MUST NOT be regressed or modified
    const sub = env.state.subscriptions.find((s) => s.id === env.subscriptionId)!;
    assert.strictEqual(sub.status, BillingSubscriptionStatus.ACTIVE);
    assert.strictEqual(sub.version, 1);
  });

  it('7. Renewal payment replay: confirmed exact renewal replay acknowledges cleanly without duplicate writes', async () => {
    const env = setupTestEnvironment({
      subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
      providerCustomerId: 'CUS_replay_renewal_001',
      providerSubscriptionId: 'SUB_replay_renewal_001',
      recurring: true,
    });

    const renewalRef = 'ref_confirmed_renewal_replay_001';
    const renewalTxId = 'tx_confirmed_renewal_replay_001';
    const renewalInvoiceId = 'inv_confirmed_renewal_replay_001';
    const renewalAttemptId = 'att_confirmed_renewal_replay_001';

    // Seed an already-settled renewal invoice, attempt, and ledger
    env.state.invoices.push({
      id: renewalInvoiceId,
      subscriptionId: env.subscriptionId,
      status: BillingInvoiceStatus.PAID,
      amountPaidCents: env.amountCents,
      providerInvoiceId: 'INV_confirmed_renewal_replay_001',
    });
    env.state.paymentAttempts.push({
      id: renewalAttemptId,
      invoiceId: renewalInvoiceId,
      providerReference: renewalRef,
      providerPaymentId: renewalTxId,
      status: BillingPaymentAttemptStatus.SUCCEEDED,
      amountCents: env.amountCents,
    });
    env.state.ledgerTransactions.push({
      id: 'ledger_confirmed_renewal_replay_001',
      subscriptionId: env.subscriptionId,
      invoiceId: renewalInvoiceId,
      externalReference: `paystack:payment:${renewalTxId}`,
      status: BillingLedgerTransactionStatus.POSTED,
    });

    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const replayEventId = 'evt_renewal_payment_replay_001';
    env.state.events.push({
      id: replayEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: renewalRef } },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    const processedCount = await worker.runOnce();
    assert.strictEqual(processedCount, 1);

    const event = env.state.events.find((e) => e.id === replayEventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.PROCESSED);
    assert.strictEqual(event.lastError, null);
  });

  it('8. Stale lease acknowledgment: lease-token fencing blocks expired lease from marking event PROCESSED', async () => {
    const env = setupTestEnvironment();
    const eventId = 'evt_stale_lease_001';
    env.state.events.push({
      id: eventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: env.reference } },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    // Worker claims the item with 50ms lease
    const claimedItem = await env.queue.claimOne(50, PAYSTACK_PROVIDER);
    assert.ok(claimedItem);

    // Wait 60ms so the lease expires
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Attempt to mark processed with the expired lease
    const marked = await env.queue.markProcessed(claimedItem);
    assert.strictEqual(marked, false, 'Expired lease must be fenced by the database');

    const event = env.state.events.find((e) => e.id === eventId)!;
    assert.notStrictEqual(event.status, BillingWebhookEventStatus.PROCESSED);
  });

  it('9. Out-of-order events: subscription.create before checkout reconciliation retries until checkout payment succeeds', async () => {
    const env = setupTestEnvironment({
      subscriptionStatus: BillingSubscriptionStatus.PENDING_CHECKOUT,
      providerCustomerId: undefined, // Customer not yet reconciled from payment
      recurring: true,
    });
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const subCreateEventId = 'evt_sub_create_early_001';
    env.state.events.push({
      id: subCreateEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'subscription.create',
      payload: {
        event: 'subscription.create',
        data: {
          subscription_code: 'SUB_early_create_001',
          customer: { customer_code: env.customerCode },
        },
      },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    // 9a. Runs before payment: fails with RetryableWebhookError -> stays RECEIVED, scheduled for retry
    await worker.runOnce();
    const eventAfterAttempt1 = env.state.events.find((e) => e.id === subCreateEventId)!;
    assert.strictEqual(eventAfterAttempt1.status, BillingWebhookEventStatus.RECEIVED);
    assert.strictEqual(eventAfterAttempt1.attemptCount, 1);
    assert.match(eventAfterAttempt1.lastError ?? '', /not yet been reconciled/i);

    // 9b. Checkout payment arrives and succeeds
    const checkoutEventId = 'evt_checkout_success_interim_001';
    env.state.events.push({
      id: checkoutEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: env.reference } },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });
    await worker.runOnce();
    assert.strictEqual(env.state.events.find((e) => e.id === checkoutEventId)!.status, BillingWebhookEventStatus.PROCESSED);

    // Configure gateway for subscription verification
    env.gateway.setSubscriptionResult('SUB_early_create_001', {
      providerSubscriptionId: 'sub_prov_002',
      subscriptionCode: 'SUB_early_create_001',
      customerCode: env.customerCode,
      planCode: 'PLN_starter_001',
      amountCents: env.amountCents,
      currency: 'USD',
      interval: 'monthly',
      status: 'active',
    });

    // 9c. Next run of subscription.create now succeeds and links subscription
    eventAfterAttempt1.nextAttemptAt = new Date(0); // Eligible for immediate retry
    await worker.runOnce();

    assert.strictEqual(eventAfterAttempt1.status, BillingWebhookEventStatus.PROCESSED);
    const sub = env.state.subscriptions.find((s) => s.id === env.subscriptionId)!;
    assert.strictEqual(sub.providerSubscriptionId, 'SUB_early_create_001');
    assert.strictEqual(sub.status, BillingSubscriptionStatus.ACTIVE);
  });

  it('10. Crash recovery: expired PROCESSING lease is reclaimed and processed to completion by subsequent worker run', async () => {
    const env = setupTestEnvironment();
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const crashedEventId = 'evt_crashed_worker_001';
    // Simulate an event that was in PROCESSING when the previous worker crashed 10 minutes ago
    env.state.events.push({
      id: crashedEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: env.reference } },
      status: BillingWebhookEventStatus.PROCESSING,
      attemptCount: 1,
      processingLeaseToken: 'old_crashed_token_999',
      processingLeaseUntil: new Date(Date.now() - 600_000), // Expired 10 min ago
      lastError: null,
      processedAt: null,
      receivedAt: new Date(Date.now() - 600_000),
      nextAttemptAt: new Date(Date.now() - 600_000),
    });

    const processed = await worker.runOnce();
    assert.strictEqual(processed, 1);

    const event = env.state.events.find((e) => e.id === crashedEventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.PROCESSED);
    assert.strictEqual(event.attemptCount, 2);
    assert.strictEqual(env.state.paymentAttempts[0].status, BillingPaymentAttemptStatus.SUCCEEDED);
  });

  it('11. Foreign provider rejection: rejects non-Paystack provider as FAILED terminal', async () => {
    const env = setupTestEnvironment();
    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, {
      ...workerTestConfig,
      provider: undefined, // claim any provider
    });

    const foreignEventId = 'evt_foreign_stripe_001';
    env.state.events.push({
      id: foreignEventId,
      provider: 'stripe',
      eventType: 'charge.success',
      payload: { id: 'ch_stripe_123' },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    await worker.runOnce();

    const event = env.state.events.find((e) => e.id === foreignEventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.FAILED);
    assert.match(event.lastError ?? '', /Unsupported webhook provider: stripe/i);
  });

  it('12. Renewal payment replay conflict rejection: rejects mismatched attempt cross-subscription fail-closed', async () => {
    const env = setupTestEnvironment({
      subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
      providerCustomerId: 'CUS_conflict_001',
      providerSubscriptionId: 'SUB_conflict_001',
      recurring: true,
    });

    const conflictRef = 'ref_conflict_tx_001';
    // Payment attempt belongs to a DIFFERENT subscription!
    env.state.invoices.push({
      id: 'other_sub_inv',
      subscriptionId: 'different_subscription_id_999',
      status: BillingInvoiceStatus.PAID,
      amountPaidCents: env.amountCents,
      providerInvoiceId: 'INV_diff_sub_001',
    });
    env.state.paymentAttempts.push({
      id: 'other_sub_attempt',
      invoiceId: 'other_sub_inv',
      providerReference: conflictRef,
      providerPaymentId: 'tx_conflict_999',
      status: BillingPaymentAttemptStatus.SUCCEEDED,
      amountCents: env.amountCents,
    });
    env.state.ledgerTransactions.push({
      id: 'ledger_conflict_001',
      subscriptionId: 'yet_another_sub_999',
      invoiceId: 'other_sub_inv',
      externalReference: 'paystack:payment:tx_conflict_999',
      status: BillingLedgerTransactionStatus.POSTED,
    });

    const processor = new PaystackWebhookEventProcessor(env.database, env.gateway);
    const worker = new WebhookWorker(env.queue, processor, workerTestConfig);

    const conflictEventId = 'evt_conflict_replay_001';
    env.state.events.push({
      id: conflictEventId,
      provider: PAYSTACK_PROVIDER,
      eventType: 'charge.success',
      payload: { event: 'charge.success', data: { reference: conflictRef } },
      status: BillingWebhookEventStatus.RECEIVED,
      attemptCount: 0,
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: null,
      processedAt: null,
      receivedAt: new Date(),
      nextAttemptAt: new Date(0),
    });

    await worker.runOnce();

    const event = env.state.events.find((e) => e.id === conflictEventId)!;
    assert.strictEqual(event.status, BillingWebhookEventStatus.FAILED);
    assert.match(event.lastError ?? '', /Renewal payment replay rejected/i);
  });
});
