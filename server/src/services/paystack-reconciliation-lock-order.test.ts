import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingPaymentAttemptStatus,
  BillingSubscriptionStatus,
  Prisma,
} from '@prisma/client';
import {
  PaymentGatewayError,
  type PaymentGateway,
  type VerifiedPayment,
  type VerifiedSubscription,
} from '../billing/payments';
import {
  PaystackReconciliationProcessor,
  ReconciliationPermanentError,
} from './paystack-reconciliation.service';

interface QueryRawRecord {
  query: string;
  id: string;
}

interface TestBillingState {
  subscription: {
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
  };
  invoice: {
    id: string;
    subscriptionId: string;
    periodId: string | null;
    providerInvoiceId: string | null;
    status: BillingInvoiceStatus;
    subtotalCents: number;
    totalCents: number;
    amountPaidCents: number;
    currency: string;
    paidAt: Date | null;
  };
  paymentAttempt: {
    id: string;
    invoiceId: string;
    providerReference: string | null;
    providerPaymentId: string | null;
    idempotencyKey: string;
    idempotencyKeyId: string;
    attemptNumber: number;
    amountCents: number;
    status: BillingPaymentAttemptStatus;
  };
  idempotencyRecord: {
    id: string;
    scope: string;
    key: string;
    responseBody: any;
  };
  periods: Array<any>;
  ledgerTransactions: Array<any>;
  ledgerEntries: Array<any>;
}

class StubPaymentGateway implements PaymentGateway {
  constructor(private readonly verifiedPaymentProvider: () => VerifiedPayment) {}

  async verifyTransaction(): Promise<VerifiedPayment> {
    return this.verifiedPaymentProvider();
  }

  async initializeTransaction(): Promise<any> {
    throw new Error('initializeTransaction not implemented in stub');
  }

  async createPlan(): Promise<any> {
    throw new Error('createPlan not implemented in stub');
  }

  async fetchPlanByCode(): Promise<any> {
    throw new Error('fetchPlanByCode not implemented in stub');
  }

  async fetchSubscriptionByCode(): Promise<VerifiedSubscription | null> {
    return null;
  }
}

const createMockTestState = (overrides?: {
  recurring?: boolean;
  linkedProviderSubscription?: boolean;
  alreadySucceeded?: boolean;
}): TestBillingState => {
  const teamId = randomUUID();
  const subscriptionId = randomUUID();
  const planId = randomUUID();
  const priceId = randomUUID();
  const invoiceId = randomUUID();
  const attemptId = randomUUID();
  const idempotencyId = randomUUID();
  const reference = `ref_${randomUUID()}`;
  const amountCents = 2_000;
  const recurring = overrides?.recurring ?? false;
  const alreadySucceeded = overrides?.alreadySucceeded ?? false;
  const linkedProviderSubscription = overrides?.linkedProviderSubscription ?? false;

  const checkoutOperation = {
    teamId,
    ownerId: randomUUID(),
    planCode: 'STARTER',
    priceId,
    subscriptionId,
    invoiceId,
    paymentAttemptId: attemptId,
    providerReference: reference,
    amountCents,
    currency: 'USD',
    billableStaffSeats: 3,
    recurring,
    providerPlanCode: recurring ? 'PLN_starter_monthly' : undefined,
  };

  const state: TestBillingState = {
    subscription: {
      id: subscriptionId,
      teamId,
      planId,
      priceId,
      status: alreadySucceeded ? BillingSubscriptionStatus.ACTIVE : BillingSubscriptionStatus.PENDING_CHECKOUT,
      provider: 'paystack',
      providerCustomerId: 'CUS_mock_123',
      providerSubscriptionId: linkedProviderSubscription ? 'SUB_mock_123' : null,
      currency: 'USD',
      currentPeriodStart: alreadySucceeded ? new Date() : null,
      currentPeriodEnd: alreadySucceeded ? new Date(Date.now() + 30 * 86400000) : null,
      version: 0,
      currentPlan: { id: planId, code: 'STARTER' },
      currentPrice: {
        id: priceId,
        planId,
        monthlyPriceCents: amountCents,
        includedStaffSeats: 5,
        extraStaffSeatPriceCents: 0,
        currency: 'USD',
      },
    },
    invoice: {
      id: invoiceId,
      subscriptionId,
      periodId: alreadySucceeded ? 'period_1' : null,
      providerInvoiceId: null,
      status: alreadySucceeded ? BillingInvoiceStatus.PAID : BillingInvoiceStatus.DRAFT,
      subtotalCents: amountCents,
      totalCents: amountCents,
      amountPaidCents: alreadySucceeded ? amountCents : 0,
      currency: 'USD',
      paidAt: alreadySucceeded ? new Date() : null,
    },
    paymentAttempt: {
      id: attemptId,
      invoiceId,
      providerReference: reference,
      providerPaymentId: alreadySucceeded ? 'tx_mock_123' : null,
      idempotencyKey: `key_${attemptId}`,
      idempotencyKeyId: idempotencyId,
      attemptNumber: 1,
      amountCents,
      status: alreadySucceeded ? BillingPaymentAttemptStatus.SUCCEEDED : BillingPaymentAttemptStatus.PENDING,
    },
    idempotencyRecord: {
      id: idempotencyId,
      scope: `team-billing-checkout:${teamId}`,
      key: `key_${attemptId}`,
      responseBody: checkoutOperation,
    },
    periods: alreadySucceeded
      ? [
          {
            id: 'period_1',
            subscriptionId,
            sequence: 1,
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 30 * 86400000),
            billableStaffSeats: 3,
            extraStaffSeats: 0,
            baseAmountCents: amountCents,
            extraSeatAmountCents: 0,
            totalAmountCents: amountCents,
          },
        ]
      : [],
    ledgerTransactions: alreadySucceeded
      ? [
          {
            id: 'ledger_1',
            externalReference: 'paystack:payment:tx_mock_123',
            status: BillingLedgerTransactionStatus.POSTED,
          },
        ]
      : [],
    ledgerEntries: [],
  };

  return state;
};

const createMockDatabaseAndTracker = (state: TestBillingState) => {
  const rawQueryLog: QueryRawRecord[] = [];
  let retryCount = 0;
  let failFirstAttemptsWithP2034 = 0;

  const getAttemptWithContext = () => ({
    ...state.paymentAttempt,
    invoice: {
      ...state.invoice,
      subscription: {
        ...state.subscription,
        currentPlan: state.subscription.currentPlan,
        currentPrice: state.subscription.currentPrice,
      },
    },
    idempotencyRecord: state.idempotencyRecord,
  });

  const transactionClient: any = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const queryText = strings.join('?').trim();
      const id = String(values[0] ?? '');
      rawQueryLog.push({ query: queryText, id });
      return [{ id }];
    },
    billingPaymentAttempt: {
      findFirst: async () => getAttemptWithContext(),
      findUnique: async (args: any) => {
        if (args.where?.id) {
          if (args.where.id === state.paymentAttempt.id) {
            return getAttemptWithContext();
          }
          return null;
        }
        if (args.where?.providerPaymentId) {
          if (state.paymentAttempt.providerPaymentId === args.where.providerPaymentId) {
            return state.paymentAttempt;
          }
          return null;
        }
        return null;
      },
      update: async (args: any) => {
        Object.assign(state.paymentAttempt, args.data);
        return state.paymentAttempt;
      },
    },
    billingInvoice: {
      update: async (args: any) => {
        Object.assign(state.invoice, args.data);
        return state.invoice;
      },
    },
    billingSubscription: {
      findUnique: async (args: any) => {
        if (args.where?.id === state.subscription.id) {
          return state.subscription;
        }
        if (args.where?.providerCustomerId && args.where.providerCustomerId === state.subscription.providerCustomerId) {
          return state.subscription;
        }
        return null;
      },
      update: async (args: any) => {
        if (args.data.version?.increment) {
          state.subscription.version += 1;
        }
        const { version, ...rest } = args.data;
        Object.assign(state.subscription, rest);
        return state.subscription;
      },
    },
    billingPeriod: {
      findFirst: async () => state.periods[0] ?? null,
      create: async (args: any) => {
        const period = { id: `period_${randomUUID()}`, ...args.data };
        state.periods.push(period);
        return period;
      },
    },
    billingLedgerTransaction: {
      findUnique: async (args: any) => {
        return state.ledgerTransactions.find((tx) => tx.externalReference === args.where.externalReference) ?? null;
      },
      create: async (args: any) => {
        const ledger = { id: `ledger_${randomUUID()}`, ...args.data };
        state.ledgerTransactions.push(ledger);
        return ledger;
      },
      update: async (args: any) => {
        const ledger = state.ledgerTransactions.find((tx) => tx.id === args.where.id);
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
    billingPaymentAttempt: {
      findUnique: async (args: any) => {
        if (args.where?.providerReference === state.paymentAttempt.providerReference) {
          return getAttemptWithContext();
        }
        return null;
      },
    },
  };

  const transactionRunner = async <T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> => {
    retryCount += 1;
    if (failFirstAttemptsWithP2034 > 0) {
      failFirstAttemptsWithP2034 -= 1;
      const error = new Prisma.PrismaClientKnownRequestError(
        'Transaction failed due to serialization conflict',
        { code: 'P2034', clientVersion: '6.4.1' }
      );
      throw error;
    }
    return operation(transactionClient);
  };

  return {
    database,
    transactionRunner,
    rawQueryLog,
    getRetryCount: () => retryCount,
    setFailFirstAttemptsWithP2034: (count: number) => {
      failFirstAttemptsWithP2034 = count;
    },
  };
};

describe('Paystack Checkout Lock Order and Business Behavior', () => {
  it('1. Acquires BillingSubscription lock BEFORE BillingInvoice and BillingPaymentAttempt locks', async () => {
    const state = createMockTestState({ recurring: false });
    const { database, transactionRunner, rawQueryLog } = createMockDatabaseAndTracker(state);
    const gateway = new StubPaymentGateway(() => ({
      reference: state.paymentAttempt.providerReference!,
      status: 'success',
      amountCents: 2_000,
      currency: 'USD',
      providerTransactionId: 'tx_first_lock_test',
      providerCustomerId: state.subscription.providerCustomerId!,
    }));

    const processor = new PaystackReconciliationProcessor(database, gateway, transactionRunner);
    await processor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'charge.success',
      payload: {
        event: 'charge.success',
        data: { reference: state.paymentAttempt.providerReference },
      },
    });

    // Verify exactly 3 row locks were acquired
    assert.strictEqual(rawQueryLog.length, 3, 'Must acquire exactly 3 FOR UPDATE row locks');

    // 1st lock must be BillingSubscription
    assert.match(
      rawQueryLog[0].query,
      /SELECT "id" FROM "BillingSubscription" WHERE "id" = \? FOR UPDATE/i,
      'First lock must be on BillingSubscription'
    );
    assert.strictEqual(rawQueryLog[0].id, state.subscription.id, 'Must lock correct subscription ID');

    // 2nd lock must be BillingInvoice
    assert.match(
      rawQueryLog[1].query,
      /SELECT "id" FROM "BillingInvoice" WHERE "id" = \? FOR UPDATE/i,
      'Second lock must be on BillingInvoice'
    );
    assert.strictEqual(rawQueryLog[1].id, state.invoice.id, 'Must lock correct invoice ID');

    // 3rd lock must be BillingPaymentAttempt
    assert.match(
      rawQueryLog[2].query,
      /SELECT "id" FROM "BillingPaymentAttempt" WHERE "id" = \? FOR UPDATE/i,
      'Third lock must be on BillingPaymentAttempt'
    );
    assert.strictEqual(rawQueryLog[2].id, state.paymentAttempt.id, 'Must lock correct payment attempt ID');
  });

  it('2. Existing initial-checkout success behavior remains unchanged (one-off checkout)', async () => {
    const state = createMockTestState({ recurring: false });
    const { database, transactionRunner } = createMockDatabaseAndTracker(state);
    const providerTransactionId = 'tx_success_one_off';
    const gateway = new StubPaymentGateway(() => ({
      reference: state.paymentAttempt.providerReference!,
      status: 'success',
      amountCents: 2_000,
      currency: 'USD',
      providerTransactionId,
      providerCustomerId: state.subscription.providerCustomerId!,
    }));

    const processor = new PaystackReconciliationProcessor(database, gateway, transactionRunner);
    await processor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'charge.success',
      payload: {
        event: 'charge.success',
        data: { reference: state.paymentAttempt.providerReference },
      },
    });

    // Verify payment attempt succeeded
    assert.strictEqual(state.paymentAttempt.status, BillingPaymentAttemptStatus.SUCCEEDED);
    assert.strictEqual(state.paymentAttempt.providerPaymentId, providerTransactionId);

    // Verify invoice paid
    assert.strictEqual(state.invoice.status, BillingInvoiceStatus.PAID);
    assert.strictEqual(state.invoice.amountPaidCents, 2_000);
    assert.ok(state.invoice.paidAt instanceof Date);

    // Verify subscription activated
    assert.strictEqual(state.subscription.status, BillingSubscriptionStatus.ACTIVE);
    assert.ok(state.subscription.currentPeriodStart instanceof Date);
    assert.ok(state.subscription.currentPeriodEnd instanceof Date);

    // Verify period sequence 1 created
    assert.strictEqual(state.periods.length, 1);
    assert.strictEqual(state.periods[0].sequence, 1);
    assert.strictEqual(state.periods[0].totalAmountCents, 2_000);

    // Verify balanced posted ledger transaction
    assert.strictEqual(state.ledgerTransactions.length, 1);
    assert.strictEqual(state.ledgerTransactions[0].status, BillingLedgerTransactionStatus.POSTED);
    assert.strictEqual(
      state.ledgerTransactions[0].externalReference,
      `paystack:payment:${providerTransactionId}`
    );

    // Verify ledger entries (cash debit, accounts receivable credit)
    assert.strictEqual(state.ledgerEntries.length, 2);
    const cashEntry = state.ledgerEntries.find((e) => e.accountCode === 'cash');
    const arEntry = state.ledgerEntries.find((e) => e.accountCode === 'accounts_receivable');
    assert.ok(cashEntry && cashEntry.debitCents === 2_000 && cashEntry.creditCents === 0);
    assert.ok(arEntry && arEntry.debitCents === 0 && arEntry.creditCents === 2_000);
  });

  it('3. Duplicate charge.success remains idempotent and returns cleanly', async () => {
    const state = createMockTestState({ recurring: false, alreadySucceeded: true });
    const { database, transactionRunner, rawQueryLog } = createMockDatabaseAndTracker(state);
    const gateway = new StubPaymentGateway(() => ({
      reference: state.paymentAttempt.providerReference!,
      status: 'success',
      amountCents: 2_000,
      currency: 'USD',
      providerTransactionId: 'tx_mock_123',
      providerCustomerId: state.subscription.providerCustomerId!,
    }));

    const processor = new PaystackReconciliationProcessor(database, gateway, transactionRunner);
    await processor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'charge.success',
      payload: {
        event: 'charge.success',
        data: { reference: state.paymentAttempt.providerReference },
      },
    });

    // Locks acquired under safe order
    assert.strictEqual(rawQueryLog.length, 3);
    assert.strictEqual(rawQueryLog[0].id, state.subscription.id);
    assert.strictEqual(rawQueryLog[1].id, state.invoice.id);
    assert.strictEqual(rawQueryLog[2].id, state.paymentAttempt.id);

    // No extra ledger entries or periods created
    assert.strictEqual(state.periods.length, 1);
    assert.strictEqual(state.ledgerTransactions.length, 1);
  });

  it('4. Conflicting payment identity continues to fail closed', async () => {
    const state = createMockTestState({ recurring: false });
    const { database, transactionRunner } = createMockDatabaseAndTracker(state);

    // Mismatched amount
    const gateway = new StubPaymentGateway(() => ({
      reference: state.paymentAttempt.providerReference!,
      status: 'success',
      amountCents: 5_000, // Conflict: attempt is 2_000
      currency: 'USD',
      providerTransactionId: 'tx_conflict_123',
      providerCustomerId: state.subscription.providerCustomerId!,
    }));

    const processor = new PaystackReconciliationProcessor(database, gateway, transactionRunner);
    await assert.rejects(
      async () => {
        await processor.process({
          id: randomUUID(),
          provider: 'paystack',
          eventType: 'charge.success',
          payload: {
            event: 'charge.success',
            data: { reference: state.paymentAttempt.providerReference },
          },
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof ReconciliationPermanentError);
        assert.match((error as Error).message, /Provider verification did not match/i);
        return true;
      }
    );

    // State remains uncommitted
    assert.strictEqual(state.paymentAttempt.status, BillingPaymentAttemptStatus.PENDING);
    assert.strictEqual(state.invoice.status, BillingInvoiceStatus.DRAFT);
    assert.strictEqual(state.subscription.status, BillingSubscriptionStatus.PENDING_CHECKOUT);
  });

  it('5. Recurring initial checkout still requires verified provider subscription linkage before activation', async () => {
    // Unlinked recurring checkout (providerSubscriptionId is null)
    const state = createMockTestState({ recurring: true, linkedProviderSubscription: false });
    const { database, transactionRunner } = createMockDatabaseAndTracker(state);
    const gateway = new StubPaymentGateway(() => ({
      reference: state.paymentAttempt.providerReference!,
      status: 'success',
      amountCents: 2_000,
      currency: 'USD',
      providerTransactionId: 'tx_recurring_unlinked',
      providerCustomerId: state.subscription.providerCustomerId!,
    }));

    const processor = new PaystackReconciliationProcessor(database, gateway, transactionRunner);
    await processor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'charge.success',
      payload: {
        event: 'charge.success',
        data: { reference: state.paymentAttempt.providerReference },
      },
    });

    // Payment attempt and invoice succeed
    assert.strictEqual(state.paymentAttempt.status, BillingPaymentAttemptStatus.SUCCEEDED);
    assert.strictEqual(state.invoice.status, BillingInvoiceStatus.PAID);

    // Subscription remains PENDING_CHECKOUT awaiting provider subscription linkage
    assert.strictEqual(state.subscription.status, BillingSubscriptionStatus.PENDING_CHECKOUT);
    assert.strictEqual(state.periods.length, 0, 'No billing period created until linked');

    // Now test with linked recurring subscription
    const linkedState = createMockTestState({ recurring: true, linkedProviderSubscription: true });
    const { database: linkedDb, transactionRunner: linkedRunner } = createMockDatabaseAndTracker(linkedState);
    const linkedGateway = new StubPaymentGateway(() => ({
      reference: linkedState.paymentAttempt.providerReference!,
      status: 'success',
      amountCents: 2_000,
      currency: 'USD',
      providerTransactionId: 'tx_recurring_linked',
      providerCustomerId: linkedState.subscription.providerCustomerId!,
    }));

    const linkedProcessor = new PaystackReconciliationProcessor(linkedDb, linkedGateway, linkedRunner);
    await linkedProcessor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'charge.success',
      payload: {
        event: 'charge.success',
        data: { reference: linkedState.paymentAttempt.providerReference },
      },
    });

    // Linked subscription activates immediately
    assert.strictEqual(linkedState.subscription.status, BillingSubscriptionStatus.ACTIVE);
    assert.strictEqual(linkedState.periods.length, 1, 'Period sequence 1 created on linked activation');
  });

  it('6. Existing retryable database failures (P2034) retain their current safe retry handling', async () => {
    const state = createMockTestState({ recurring: false });
    const tracker = createMockDatabaseAndTracker(state);
    // Simulate 2 transient serialization conflicts before success
    tracker.setFailFirstAttemptsWithP2034(2);

    const gateway = new StubPaymentGateway(() => ({
      reference: state.paymentAttempt.providerReference!,
      status: 'success',
      amountCents: 2_000,
      currency: 'USD',
      providerTransactionId: 'tx_retry_test',
      providerCustomerId: state.subscription.providerCustomerId!,
    }));

    const processor = new PaystackReconciliationProcessor(
      tracker.database,
      gateway,
      tracker.transactionRunner
    );

    await processor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'charge.success',
      payload: {
        event: 'charge.success',
        data: { reference: state.paymentAttempt.providerReference },
      },
    });

    // Took 3 attempts (2 failed with P2034, 3rd succeeded)
    assert.strictEqual(tracker.getRetryCount(), 3, 'Must retry twice and succeed on 3rd attempt');

    // On the successful 3rd attempt, locks were acquired in the correct order
    assert.strictEqual(state.paymentAttempt.status, BillingPaymentAttemptStatus.SUCCEEDED);
    assert.strictEqual(state.invoice.status, BillingInvoiceStatus.PAID);
    assert.strictEqual(state.subscription.status, BillingSubscriptionStatus.ACTIVE);
  });
});
