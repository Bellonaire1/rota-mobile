import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingLedgerTransactionType,
  BillingPaymentAttemptStatus,
  BillingPeriodStatus,
  BillingSubscriptionStatus,
  Prisma,
} from '@prisma/client';
import { RENEWAL_BILLING_POLICIES } from '../billing/billing-calendar';
import { PermanentWebhookError } from '../jobs/webhook-event-processor';
import {
  PaystackRenewalSettlementService,
  CASH_ACCOUNT,
  ACCOUNTS_RECEIVABLE_ACCOUNT,
  type RenewalSettlementInput,
  type RenewalSettlementResult,
} from './paystack-renewal-settlement.service';
import {
  type AuthenticatedRenewalEvidenceResult,
  DEFAULT_UNRESOLVED_FACTS,
} from './paystack-renewal-evidence.service';

/**
 * Test-scoped harness defined exclusively inside unit test suite to exercise
 * the internal atomic PostgreSQL transaction engine with constructed test fixtures.
 */
class TestOnlyRenewalSettlementHarness extends PaystackRenewalSettlementService {
  async settleRenewalCycleForTesting(input: RenewalSettlementInput): Promise<RenewalSettlementResult> {
    return this.executeAtomicSettlementTransaction(input);
  }
}

interface QueryRawRecord {
  query: string;
  id: string;
}

interface MockSettlementState {
  subscription: {
    id: string;
    teamId: string;
    planId: string;
    priceId: string;
    status: BillingSubscriptionStatus;
    provider: string;
    providerCustomerId: string;
    providerSubscriptionId: string;
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
  };
  periods: Array<any>;
  invoices: Array<any>;
  paymentAttempts: Array<any>;
  ledgerTransactions: Array<any>;
  ledgerEntries: Array<any>;
}

const createMockSettlementState = (options?: {
  subscriptionStatus?: BillingSubscriptionStatus;
  initialPeriodEndInPast?: boolean;
}): MockSettlementState => {
  const teamId = randomUUID();
  const subscriptionId = randomUUID();
  const planId = randomUUID();
  const priceId = randomUUID();
  const amountCents = 2_000;

  const seq1Start = options?.initialPeriodEndInPast
    ? new Date('2026-01-01T12:00:00.000Z')
    : new Date('2026-02-01T12:00:00.000Z');
  const seq1End = options?.initialPeriodEndInPast
    ? new Date('2026-02-01T12:00:00.000Z')
    : new Date('2026-03-01T12:00:00.000Z');

  return {
    subscription: {
      id: subscriptionId,
      teamId,
      planId,
      priceId,
      status: options?.subscriptionStatus ?? BillingSubscriptionStatus.ACTIVE,
      provider: 'paystack',
      providerCustomerId: 'CUS_renewal_mock_123',
      providerSubscriptionId: 'SUB_renewal_mock_123',
      currency: 'USD',
      currentPeriodStart: seq1Start,
      currentPeriodEnd: seq1End,
      gracePeriodEndsAt: null,
      version: 1,
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
    periods: [
      {
        id: 'period_seq_1',
        subscriptionId,
        sequence: 1,
        startsAt: seq1Start,
        endsAt: seq1End,
        planCodeSnapshot: 'STARTER',
        monthlyPriceCents: amountCents,
        includedStaffSeats: 5,
        extraStaffSeatPriceCents: 0,
        billableStaffSeats: 3,
        extraStaffSeats: 0,
        baseAmountCents: amountCents,
        extraSeatAmountCents: 0,
        totalAmountCents: amountCents,
        currency: 'USD',
        status: BillingPeriodStatus.FINALIZED,
      },
    ],
    invoices: [
      {
        id: 'invoice_seq_1',
        subscriptionId,
        periodId: 'period_seq_1',
        providerInvoiceId: 'INV_initial_checkout_001',
        status: BillingInvoiceStatus.PAID,
        subtotalCents: amountCents,
        totalCents: amountCents,
        amountPaidCents: amountCents,
        currency: 'USD',
        paidAt: seq1Start,
      },
    ],
    paymentAttempts: [
      {
        id: 'attempt_seq_1',
        invoiceId: 'invoice_seq_1',
        providerReference: 'ref_initial_checkout_001',
        providerPaymentId: 'tx_initial_checkout_001',
        idempotencyKey: 'key_initial_001',
        attemptNumber: 1,
        amountCents,
        status: BillingPaymentAttemptStatus.SUCCEEDED,
      },
    ],
    ledgerTransactions: [
      {
        id: 'ledger_seq_1',
        externalReference: 'paystack:payment:tx_initial_checkout_001',
        subscriptionId,
        invoiceId: 'invoice_seq_1',
        status: BillingLedgerTransactionStatus.POSTED,
        type: BillingLedgerTransactionType.PAYMENT,
      },
    ],
    ledgerEntries: [],
  };
};

const createMockDatabase = (state: MockSettlementState) => {
  const rawQueryLog: QueryRawRecord[] = [];
  let failFirstAttemptsWithP2034 = 0;
  let retryCount = 0;

  const transactionClient: any = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const queryText = strings.join('?').trim();
      const id = String(values[0] ?? '');
      rawQueryLog.push({ query: queryText, id });
      return [{ id }];
    },
    billingSubscription: {
      findUnique: async (args: any) => {
        if (args.where?.id === state.subscription.id) {
          return {
            ...state.subscription,
            currentPlan: state.subscription.currentPlan,
            currentPrice: state.subscription.currentPrice,
          };
        }
        return null;
      },
      update: async (args: any) => {
        if (args.data.version?.increment) state.subscription.version += 1;
        const { version, ...rest } = args.data;
        Object.assign(state.subscription, rest);
        return state.subscription;
      },
    },
    billingPeriod: {
      findFirst: async (args: any) => {
        if (args.where?.sequence) {
          return state.periods.find((p) => p.sequence === args.where.sequence) ?? null;
        }
        if (args.orderBy?.sequence === 'desc') {
          return state.periods[state.periods.length - 1] ?? null;
        }
        return state.periods[0] ?? null;
      },
      create: async (args: any) => {
        const period = { id: `period_${randomUUID()}`, ...args.data };
        state.periods.push(period);
        return period;
      },
    },
    billingInvoice: {
      findUnique: async (args: any) => {
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
      create: async (args: any) => {
        const invoice = { id: `invoice_${randomUUID()}`, ...args.data };
        state.invoices.push(invoice);
        return invoice;
      },
    },
    billingPaymentAttempt: {
      findUnique: async (args: any) => {
        if (args.where?.providerPaymentId) {
          const att = state.paymentAttempts.find((a) => a.providerPaymentId === args.where.providerPaymentId);
          if (att) {
            const inv = state.invoices.find((i) => i.id === att.invoiceId);
            return { ...att, invoice: inv };
          }
        }
        if (args.where?.providerReference) {
          const att = state.paymentAttempts.find((a) => a.providerReference === args.where.providerReference);
          if (att) {
            const inv = state.invoices.find((i) => i.id === att.invoiceId);
            return { ...att, invoice: inv };
          }
        }
        return null;
      },
      create: async (args: any) => {
        const attempt = { id: `attempt_${randomUUID()}`, ...args.data };
        state.paymentAttempts.push(attempt);
        return attempt;
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

  const database: any = transactionClient;

  const transactionRunner = async <T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> => {
    retryCount += 1;
    if (failFirstAttemptsWithP2034 > 0) {
      failFirstAttemptsWithP2034 -= 1;
      throw new Prisma.PrismaClientKnownRequestError('Transaction serialization failure', {
        code: 'P2034',
        clientVersion: '6.4.1',
      });
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

const createMockEvidence = (
  state: MockSettlementState,
  overrides?: {
    invoiceCode?: string;
    reference?: string;
    providerTransactionId?: string;
    amountCents?: number;
    paidAt?: Date;
    unresolvedFacts?: readonly string[];
  }
): AuthenticatedRenewalEvidenceResult => ({
  outcome: 'AUTHENTICATED_EVIDENCE_PRODUCED',
  isReadyForSettlement: false, // Proof gate flag defaults strictly to false
  webhookAssociation: {
    webhookEventId: 'wh_event_mock_001',
    signatureVerifiedAt: new Date(),
    eventType: 'invoice.update',
    invoiceCode: overrides?.invoiceCode ?? 'INV_renewal_cycle_002',
    subscriptionCode: state.subscription.providerSubscriptionId,
    transactionReference: overrides?.reference ?? 'ref_renewal_cycle_002',
    customerCode: state.subscription.providerCustomerId,
    amountCents: overrides?.amountCents ?? 2_000,
    currency: 'USD',
    invoicePaidAt: overrides?.paidAt ?? new Date('2026-03-01T12:00:00.000Z'),
  },
  subscriptionProof: {
    providerSubscriptionId: 'sub_provider_id_123',
    subscriptionCode: state.subscription.providerSubscriptionId,
    providerCustomerId: state.subscription.providerCustomerId,
    planCode: 'STARTER',
    amountCents: overrides?.amountCents ?? 2_000,
    currency: 'USD',
    interval: 'monthly',
    status: 'active',
    localSubscriptionId: state.subscription.id,
    teamId: state.subscription.teamId,
  },
  transactionProof: {
    reference: overrides?.reference ?? 'ref_renewal_cycle_002',
    providerTransactionId: overrides?.providerTransactionId ?? 'tx_renewal_cycle_002',
    providerCustomerId: state.subscription.providerCustomerId,
    amountCents: overrides?.amountCents ?? 2_000,
    currency: 'USD',
    status: 'success',
  },
  unresolvedFacts: overrides?.unresolvedFacts ?? DEFAULT_UNRESOLVED_FACTS,
});

describe('PaystackRenewalSettlementService - Security Boundary & Proof Gate', () => {
  it('1. Production settlement strictly refuses unready evidence (isReadyForSettlement: false)', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner, rawQueryLog } = createMockDatabase(state);
    const service = new PaystackRenewalSettlementService(database, transactionRunner);

    const evidence = createMockEvidence(state);
    assert.strictEqual(evidence.isReadyForSettlement, false);

    const result = await service.settleRenewalCycle({
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });

    assert.strictEqual(result.status, 'SETTLEMENT_REFUSED_PROOF_GATE');
    if (result.status === 'SETTLEMENT_REFUSED_PROOF_GATE') {
      assert.match(result.reason, /Production settlement gate refused/i);
    }

    // Zero database queries executed, zero locks, zero records written
    assert.strictEqual(rawQueryLog.length, 0);
    assert.strictEqual(state.periods.length, 1);
    assert.strictEqual(state.invoices.length, 1);
    assert.strictEqual(state.paymentAttempts.length, 1);
    assert.strictEqual(state.ledgerTransactions.length, 1);
  });

  it('2. Caller cannot bypass the proof gate by supplying extra properties (allowTestFixtureProof, bypass, force, user-provided readiness flags)', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner, rawQueryLog } = createMockDatabase(state);
    const service = new PaystackRenewalSettlementService(database, transactionRunner);

    const evidence = createMockEvidence(state);

    // 2a. Malicious or accidental caller passing unauthorized bypass flags
    const maliciousInput = {
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
      allowTestFixtureProof: true,
      bypass: true,
      force: true,
      trusted: true,
      isReadyForSettlement: true, // user-provided readiness flag at root
    } as any;

    const result = await service.settleRenewalCycle(maliciousInput);
    assert.strictEqual(result.status, 'SETTLEMENT_REFUSED_PROOF_GATE');
    assert.match(result.reason, /unauthorized caller property/i);

    // 2b. Caller attempting to set isReadyForSettlement: true on evidence with unresolved facts
    const forgedEvidenceInput = {
      evidence: {
        ...evidence,
        isReadyForSettlement: true, // user-provided readiness flag on evidence
      },
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    } as any;

    const forgedResult = await service.settleRenewalCycle(forgedEvidenceInput);
    assert.strictEqual(forgedResult.status, 'SETTLEMENT_REFUSED_PROOF_GATE');

    // 2c. Malformed, null, or empty inputs fail closed
    const nullResult = await service.settleRenewalCycle(null as any);
    assert.strictEqual(nullResult.status, 'SETTLEMENT_REFUSED_PROOF_GATE');

    const emptyResult = await service.settleRenewalCycle({} as any);
    assert.strictEqual(emptyResult.status, 'SETTLEMENT_REFUSED_PROOF_GATE');

    // Zero database queries executed, zero locks, zero records written
    assert.strictEqual(rawQueryLog.length, 0);
    assert.strictEqual(state.periods.length, 1);
    assert.strictEqual(state.invoices.length, 1);
  });

  it('3. Rejected evidence causes zero financial writes and no row locking', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner, rawQueryLog } = createMockDatabase(state);
    const service = new PaystackRenewalSettlementService(database, transactionRunner);

    const evidence = createMockEvidence(state);
    await service.settleRenewalCycle({
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.ORIGINAL_ANNIVERSARY_ANCHORING,
    });

    assert.strictEqual(rawQueryLog.length, 0, 'No row locks must be acquired on rejected evidence');
    assert.strictEqual(state.periods.length, 1, 'No new period created');
    assert.strictEqual(state.invoices.length, 1, 'No new invoice created');
    assert.strictEqual(state.paymentAttempts.length, 1, 'No new attempt created');
    assert.strictEqual(state.ledgerTransactions.length, 1, 'No new ledger transaction created');
    assert.strictEqual(state.subscription.version, 1, 'Subscription version must remain untouched');
  });

  it('4. Isolated test harness verifies atomic settlement logic without modifying production API', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner, rawQueryLog } = createMockDatabase(state);
    const now = new Date('2026-03-01T14:00:00.000Z');
    // Using the explicitly scoped test-only harness
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner, () => now);

    const evidence = createMockEvidence(state, {
      invoiceCode: 'INV_renewal_002',
      reference: 'ref_renewal_002',
      providerTransactionId: 'tx_renewal_002',
    });

    const result = await harness.settleRenewalCycleForTesting({
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });

    assert.strictEqual(result.status, 'SETTLED');
    if (result.status === 'SETTLED') {
      assert.strictEqual(result.sequence, 2);
      assert.strictEqual(result.subscriptionStatus, BillingSubscriptionStatus.ACTIVE);
      assert.deepStrictEqual(result.currentPeriodStart, new Date('2026-03-01T12:00:00.000Z'));
      assert.deepStrictEqual(result.currentPeriodEnd, new Date('2026-04-01T12:00:00.000Z'));
    }

    // Verify row lock acquired first
    assert.strictEqual(rawQueryLog.length, 1);
    assert.match(
      rawQueryLog[0].query,
      /SELECT "id" FROM "BillingSubscription" WHERE "id" = \? FOR UPDATE/i
    );

    // Verify BillingPeriod sequence 2
    assert.strictEqual(state.periods.length, 2);
    const newPeriod = state.periods[1];
    assert.strictEqual(newPeriod.sequence, 2);
    assert.deepStrictEqual(newPeriod.startsAt, state.periods[0].endsAt);
    assert.strictEqual(newPeriod.status, BillingPeriodStatus.FINALIZED);

    // Verify BillingInvoice
    assert.strictEqual(state.invoices.length, 2);
    assert.strictEqual(state.invoices[1].providerInvoiceId, 'INV_renewal_002');
    assert.strictEqual(state.invoices[1].status, BillingInvoiceStatus.PAID);

    // Verify BillingPaymentAttempt
    assert.strictEqual(state.paymentAttempts.length, 2);
    assert.strictEqual(state.paymentAttempts[1].providerPaymentId, 'tx_renewal_002');
    assert.strictEqual(state.paymentAttempts[1].status, BillingPaymentAttemptStatus.SUCCEEDED);

    // Verify balanced POSTED ledger transaction
    assert.strictEqual(state.ledgerTransactions.length, 2);
    assert.strictEqual(state.ledgerTransactions[1].status, BillingLedgerTransactionStatus.POSTED);
    assert.strictEqual(state.ledgerEntries.length, 2);
    const cashEntry = state.ledgerEntries.find((e) => e.accountCode === CASH_ACCOUNT);
    const arEntry = state.ledgerEntries.find((e) => e.accountCode === ACCOUNTS_RECEIVABLE_ACCOUNT);
    assert.ok(cashEntry && cashEntry.debitCents === 2_000 && cashEntry.creditCents === 0);
    assert.ok(arEntry && arEntry.debitCents === 0 && arEntry.creditCents === 2_000);

    // Verify subscription updated
    assert.strictEqual(state.subscription.status, BillingSubscriptionStatus.ACTIVE);
    assert.strictEqual(state.subscription.version, 2);
  });

  it('5. Exact replay remains idempotent with zero duplicate writes', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner } = createMockDatabase(state);
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner);

    const evidence = createMockEvidence(state, {
      invoiceCode: 'INV_replay_test_002',
      reference: 'ref_replay_test_002',
      providerTransactionId: 'tx_replay_test_002',
    });

    const firstRun = await harness.settleRenewalCycleForTesting({
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });
    assert.strictEqual(firstRun.status, 'SETTLED');

    const periodsCount = state.periods.length;
    const invoicesCount = state.invoices.length;
    const attemptsCount = state.paymentAttempts.length;
    const ledgerCount = state.ledgerTransactions.length;

    // Second execution of the exact same event
    const secondRun = await harness.settleRenewalCycleForTesting({
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });

    assert.strictEqual(secondRun.status, 'EXACT_REPLAY_ACKNOWLEDGED');
    assert.strictEqual(state.periods.length, periodsCount);
    assert.strictEqual(state.invoices.length, invoicesCount);
    assert.strictEqual(state.paymentAttempts.length, attemptsCount);
    assert.strictEqual(state.ledgerTransactions.length, ledgerCount);
  });

  it('6. Conflict rejection: Rejects cross-subscription reuse fail-closed', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner } = createMockDatabase(state);
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner);

    // Inject an existing invoice with the same invoice code belonging to a DIFFERENT subscription
    state.invoices.push({
      id: 'other_sub_inv',
      subscriptionId: 'other_sub_id',
      providerInvoiceId: 'INV_cross_sub_conflict',
      status: BillingInvoiceStatus.PAID,
    });

    const evidence = createMockEvidence(state, {
      invoiceCode: 'INV_cross_sub_conflict',
    });

    await assert.rejects(
      async () => {
        await harness.settleRenewalCycleForTesting({
          evidence,
          billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof PermanentWebhookError);
        assert.match((error as Error).message, /already bound to another subscription/i);
        return true;
      }
    );
  });

  it('7. Entitlement: Late payment for an expired historical cycle settles debt but does NOT grant active access for unpaid future cycles', async () => {
    const state = createMockSettlementState({
      subscriptionStatus: BillingSubscriptionStatus.SUSPENDED,
      initialPeriodEndInPast: true, // seq 1 ends 2026-02-01
    });
    const { database, transactionRunner } = createMockDatabase(state);
    const now = new Date('2026-04-15T12:00:00.000Z');
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner, () => now);

    // Settling cycle 2: starts 2026-02-01, ends 2026-03-01 (still in the past relative to 2026-04-15!)
    const evidence = createMockEvidence(state, {
      invoiceCode: 'INV_late_expired_cycle',
      reference: 'ref_late_expired_cycle',
      providerTransactionId: 'tx_late_expired_cycle',
      paidAt: new Date('2026-04-15T10:00:00.000Z'),
    });

    const result = await harness.settleRenewalCycleForTesting({
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });

    assert.strictEqual(result.status, 'SETTLED');
    if (result.status === 'SETTLED') {
      // Must NOT be set to ACTIVE! Must remain SUSPENDED because endsAt (2026-03-01) <= now (2026-04-15).
      assert.notStrictEqual(result.subscriptionStatus, BillingSubscriptionStatus.ACTIVE);
      assert.strictEqual(state.subscription.status, BillingSubscriptionStatus.SUSPENDED);
    }

    // Historical debt settled
    assert.strictEqual(state.invoices[1].status, BillingInvoiceStatus.PAID);
    assert.strictEqual(state.ledgerTransactions[1].status, BillingLedgerTransactionStatus.POSTED);
  });

  it('8. Concurrency: Retries on P2034 serialization conflicts and completes safely', async () => {
    const state = createMockSettlementState();
    const mock = createMockDatabase(state);
    mock.setFailFirstAttemptsWithP2034(2); // Simulate 2 transient serialization conflicts

    const harness = new TestOnlyRenewalSettlementHarness(mock.database, mock.transactionRunner);
    const evidence = createMockEvidence(state);

    const result = await harness.settleRenewalCycleForTesting({
      evidence,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });

    assert.strictEqual(result.status, 'SETTLED');
    assert.strictEqual(mock.getRetryCount(), 3, 'Must retry twice and succeed on 3rd attempt');
    assert.strictEqual(state.periods.length, 2);
  });

  it('9. Out-of-order replay: Duplicate of older cycle after a later cycle has settled does not regress currentPeriodEnd', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner } = createMockDatabase(state);
    const now = new Date('2026-04-01T14:00:00.000Z');
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner, () => now);

    // Settle cycle 2 (Feb 1 -> Mar 1, ends 2026-04-01)
    const evidenceCycle2 = createMockEvidence(state, {
      invoiceCode: 'INV_cycle_002',
      reference: 'ref_cycle_002',
      providerTransactionId: 'tx_cycle_002',
    });
    const result2 = await harness.settleRenewalCycleForTesting({
      evidence: evidenceCycle2,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });
    assert.strictEqual(result2.status, 'SETTLED');

    // Settle cycle 3 (Mar 1 -> Apr 1, ends 2026-05-01)
    const evidenceCycle3 = createMockEvidence(state, {
      invoiceCode: 'INV_cycle_003',
      reference: 'ref_cycle_003',
      providerTransactionId: 'tx_cycle_003',
    });
    const result3 = await harness.settleRenewalCycleForTesting({
      evidence: evidenceCycle3,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });
    assert.strictEqual(result3.status, 'SETTLED');

    const expectedCurrentPeriodEnd = new Date('2026-05-01T12:00:00.000Z');
    assert.deepStrictEqual(state.subscription.currentPeriodEnd, expectedCurrentPeriodEnd);
    assert.strictEqual(state.periods.length, 3);

    // Duplicate delivery of cycle 2 arrives
    const duplicateResult = await harness.settleRenewalCycleForTesting({
      evidence: evidenceCycle2,
      billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
    });

    assert.strictEqual(duplicateResult.status, 'EXACT_REPLAY_ACKNOWLEDGED');
    assert.deepStrictEqual(state.subscription.currentPeriodEnd, expectedCurrentPeriodEnd);
    assert.strictEqual(state.periods.length, 3, 'Zero new periods created');
  });

  it('10. Canceled subscription: Fails closed and refuses renewal settlement', async () => {
    const state = createMockSettlementState({
      subscriptionStatus: BillingSubscriptionStatus.CANCELED,
    });
    const { database, transactionRunner } = createMockDatabase(state);
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner);
    const evidence = createMockEvidence(state);

    await assert.rejects(
      async () => {
        await harness.settleRenewalCycleForTesting({
          evidence,
          billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof PermanentWebhookError);
        assert.match((error as Error).message, /canceled subscription/i);
        return true;
      }
    );
  });

  it('11. Missing initial period (sequence 1): Fails closed', async () => {
    const state = createMockSettlementState();
    state.periods = []; // No sequence 1
    const { database, transactionRunner } = createMockDatabase(state);
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner);
    const evidence = createMockEvidence(state);

    await assert.rejects(
      async () => {
        await harness.settleRenewalCycleForTesting({
          evidence,
          billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof PermanentWebhookError);
        assert.match((error as Error).message, /initial period/i);
        return true;
      }
    );
  });

  it('12. Price breakdown mismatch: Fails closed when payment amount contradicts historical pricing', async () => {
    const state = createMockSettlementState();
    const { database, transactionRunner } = createMockDatabase(state);
    const harness = new TestOnlyRenewalSettlementHarness(database, transactionRunner);

    const evidence = createMockEvidence(state, {
      amountCents: 7_500, // Expected is 2_000
    });

    await assert.rejects(
      async () => {
        await harness.settleRenewalCycleForTesting({
          evidence,
          billingPolicy: RENEWAL_BILLING_POLICIES.CONSECUTIVE_MONTH_CLAMPING,
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof PermanentWebhookError);
        assert.match((error as Error).message, /does not match expected historical renewal pricing/i);
        return true;
      }
    );
  });
});
