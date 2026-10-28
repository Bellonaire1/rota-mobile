import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingPaymentAttemptStatus,
  BillingSubscriptionStatus,
  Prisma,
} from '@prisma/client';
import { MockPaystackGateway, PaymentGatewayError, type VerifiedPayment } from '../billing/payments';
import { prisma } from '../database/prisma';
import { PermanentWebhookError, RetryableWebhookError } from '../jobs/webhook-event-processor';
import { PaystackReconciliationProcessor } from './paystack-reconciliation.service';
import { reconciliationIntegrationSkipReason } from './reconciliation-test-safety';

type Fixture = {
  userId: string;
  teamId: string;
  subscriptionId: string;
  invoiceId: string;
  attemptId: string;
  idempotencyId: string;
  reference: string;
  providerCustomerId?: string;
  providerPlanCode?: string;
};

type HistoricalPriceInput = {
  monthlyPriceCents: number;
  includedStaffSeats: number;
  extraStaffSeatPriceCents: number;
  billableStaffSeats: number;
};

const amountCents = 2_000;

// Successful reconciliation creates immutable POSTED ledger rows. These tests
// therefore refuse the persistent branch and require a disposable branch that
// can be retired after the run; ordinary teardown cannot delete posted rows.

const eventFor = (reference: string, payloadData: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  provider: 'paystack',
  eventType: 'charge.success',
  payload: { event: 'charge.success', data: { reference, ...payloadData } },
});

const subscriptionEventFor = (
  subscriptionCode: string,
  customerCode: string,
  payloadData: Record<string, unknown> = {}
) => ({
  id: randomUUID(),
  provider: 'paystack',
  eventType: 'subscription.create',
  payload: {
    event: 'subscription.create',
    data: {
      subscription_code: subscriptionCode,
      customer: { customer_code: customerCode },
      ...payloadData,
    },
  },
});

const createFixture = async (
  gateway: MockPaystackGateway,
  options: {
    metadata?: Readonly<Record<string, string>>;
    providerCustomerId?: string | null;
    recurring?: boolean;
    providerPlanCode?: string;
  } = {}
): Promise<Fixture> => {
  const user = await prisma.user.create({
    data: { email: `reconciliation-${randomUUID()}@example.com`, name: 'Reconciliation Test', passwordHash: 'test-hash' },
  });
  const team = await prisma.team.create({ data: { name: `Reconciliation Team ${randomUUID()}`, createdByUserId: user.id } });
  await prisma.teamMembership.create({ data: { teamId: team.id, userId: user.id, role: 'OWNER' } });
  const plan = await prisma.billingPlan.findUniqueOrThrow({ where: { code: 'STARTER' } });
  const price = await prisma.billingPlanPrice.findFirstOrThrow({
    where: {
      planId: plan.id,
      effectiveTo: null,
      monthlyPriceCents: amountCents,
      includedStaffSeats: 5,
      extraStaffSeatPriceCents: 0,
      currency: 'USD',
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  const subscription = await prisma.billingSubscription.create({ data: { teamId: team.id, planId: plan.id, priceId: price.id, status: 'PENDING_CHECKOUT', currency: 'USD' } });
  const invoice = await prisma.billingInvoice.create({ data: { subscriptionId: subscription.id, subtotalCents: amountCents, totalCents: amountCents, currency: 'USD' } });
  const reference = `rota-${team.id}-${randomUUID()}`;
  const planCode = options.recurring ? (options.providerPlanCode ?? 'PLN_test_plan_code_123') : undefined;
  const idempotency = await prisma.billingIdempotencyKey.create({
    data: {
      scope: `team-billing-checkout:${team.id}`,
      key: `reconcile-${randomUUID()}`,
      requestHash: randomUUID().replaceAll('-', ''),
      status: 'SUCCEEDED',
      teamId: team.id,
      userId: user.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      responseBody: {
        state: 'CHECKOUT_PENDING', subscriptionId: subscription.id, invoiceId: invoice.id,
        paymentAttemptId: 'pending', providerReference: reference, planCode: 'STARTER',
        priceId: price.id, billableStaffSeats: 0, amountCents, currency: 'USD',
        ...(options.recurring ? { recurring: true, providerPlanCode: planCode } : {}),
      },
    },
  });
  const attempt = await prisma.billingPaymentAttempt.create({
    data: {
      invoiceId: invoice.id,
      providerReference: reference,
      idempotencyKey: `reconcile-attempt-${randomUUID()}`,
      idempotencyKeyId: idempotency.id,
      attemptNumber: 1,
      amountCents,
      status: 'PENDING',
    },
  });
  await prisma.billingIdempotencyKey.update({
    where: { id: idempotency.id },
    data: { responseBody: {
      state: 'CHECKOUT_PENDING', subscriptionId: subscription.id, invoiceId: invoice.id,
      paymentAttemptId: attempt.id, providerReference: reference, planCode: 'STARTER',
      priceId: price.id, billableStaffSeats: 0, amountCents, currency: 'USD',
      ...(options.recurring ? { recurring: true, providerPlanCode: planCode } : {}),
    } },
  });
  if (options.recurring) {
    gateway.setPlanLookupResult(planCode!, {
      providerPlanId: '99991',
      planCode: planCode!,
      name: `Rota STARTER (0 seats) - team:${team.id}`,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });
  }
  await gateway.initializeTransaction({
    amountCents,
    currency: 'USD',
    customerEmail: user.email,
    reference,
    idempotencyKey: idempotency.key,
    metadata: options.metadata ?? { mode: 'test', subscriptionId: subscription.id },
    ...(options.recurring ? {
      plan: {
        planCode: planCode!,
        expectedAmountCents: amountCents,
        expectedCurrency: 'USD',
        expectedInterval: 'monthly',
        expectedName: `Rota STARTER (0 seats) - team:${team.id}`,
      },
    } : {}),
  });
  const customerCode = options.providerCustomerId === null
    ? undefined
    : (options.providerCustomerId ?? `CUS_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`);
  gateway.simulateSuccess(reference, customerCode ? { providerCustomerId: customerCode } : undefined);
  const fixture: Fixture = {
    userId: user.id,
    teamId: team.id,
    subscriptionId: subscription.id,
    invoiceId: invoice.id,
    attemptId: attempt.id,
    idempotencyId: idempotency.id,
    reference,
    ...(customerCode ? { providerCustomerId: customerCode } : {}),
    ...(options.recurring ? { providerPlanCode: planCode } : {}),
  };
  return fixture;
};

const assertPermanent = async (operation: Promise<unknown>): Promise<void> => {
  await assert.rejects(operation, (error: unknown) => error instanceof PermanentWebhookError);
};

const useHistoricalPrice = async (fixture: Fixture, input: HistoricalPriceInput): Promise<void> => {
  const subscription = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
  const price = await prisma.billingPlanPrice.create({
    data: {
      planId: subscription.planId,
      monthlyPriceCents: input.monthlyPriceCents,
      includedStaffSeats: input.includedStaffSeats,
      extraStaffSeatPriceCents: input.extraStaffSeatPriceCents,
      currency: 'USD',
      effectiveFrom: new Date(Date.UTC(2025, 0, 1) + Math.floor(Math.random() * 86_400_000)),
    },
  });
  await prisma.billingSubscription.update({ where: { id: fixture.subscriptionId }, data: { priceId: price.id } });
  const idempotency = await prisma.billingIdempotencyKey.findUniqueOrThrow({ where: { id: fixture.idempotencyId } });
  const snapshot = idempotency.responseBody as Record<string, unknown>;
  await prisma.billingIdempotencyKey.update({
    where: { id: fixture.idempotencyId },
    data: { responseBody: { ...snapshot, priceId: price.id, billableStaffSeats: input.billableStaffSeats } },
  });
};

describe('Paystack reconciliation processor', { concurrency: false, skip: reconciliationIntegrationSkipReason() }, () => {
  before(async () => {
    const legacy = await prisma.billingWebhookEvent.count({ where: { status: 'PROCESSING', OR: [{ processingLeaseToken: null }, { processingLeaseUntil: null }] } });
    assert.equal(legacy, 0);
  });

  after(async () => prisma.$disconnect());

  it('verifies and atomically activates the pending subscription', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    await new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference));

    const attempt = await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });
    const subscription = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    const period = await prisma.billingPeriod.findFirstOrThrow({ where: { subscriptionId: fixture.subscriptionId } });
    const ledger = await prisma.billingLedgerTransaction.findFirstOrThrow({ where: { subscriptionId: fixture.subscriptionId } });
    const entries = await prisma.billingLedgerEntry.findMany({ where: { transactionId: ledger.id } });

    assert.equal(attempt.status, BillingPaymentAttemptStatus.SUCCEEDED);
    assert.equal(attempt.providerPaymentId, `mock_tx_${fixture.reference}`);
    assert.equal(invoice.status, BillingInvoiceStatus.PAID);
    assert.equal(invoice.amountPaidCents, amountCents);
    assert.equal(invoice.periodId, period.id);
    assert.equal(subscription.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(subscription.providerCustomerId, fixture.providerCustomerId);
    assert.match(subscription.providerCustomerId ?? '', /^CUS_/);
    assert.equal(ledger.status, BillingLedgerTransactionStatus.POSTED);
    assert.equal(ledger.totalDebitCents, amountCents);
    assert.equal(ledger.totalCreditCents, amountCents);
    assert.equal(entries.length, 2);
    assert.equal(entries.reduce((sum, entry) => sum + entry.debitCents, 0), entries.reduce((sum, entry) => sum + entry.creditCents, 0));
  });

  it('uses the persisted historical price when the current catalog differs', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    await useHistoricalPrice(fixture, { monthlyPriceCents: 1_800, includedStaffSeats: 0, extraStaffSeatPriceCents: 40, billableStaffSeats: 5 });
    await new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference));

    const period = await prisma.billingPeriod.findFirstOrThrow({ where: { subscriptionId: fixture.subscriptionId } });
    const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });
    assert.equal(period.planCodeSnapshot, 'STARTER');
    assert.equal(period.monthlyPriceCents, 1_800);
    assert.equal(period.includedStaffSeats, 0);
    assert.equal(period.extraStaffSeatPriceCents, 40);
    assert.equal(period.billableStaffSeats, 5);
    assert.equal(period.extraStaffSeats, 5);
    assert.equal(period.baseAmountCents, 1_800);
    assert.equal(period.extraSeatAmountCents, 200);
    assert.equal(period.totalAmountCents, 2_000);
    assert.equal(invoice.totalCents, 2_000);
    assert.equal(invoice.amountPaidCents, 2_000);
  });

  it('is financially idempotent for duplicate and differently serialized events', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await processor.process(eventFor(fixture.reference, { amount: 2_000 }));
    await processor.process(eventFor(fixture.reference, { amount: 999_999, currency: 'NGN' }));
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingPaymentAttempt.count({ where: { providerPaymentId: `mock_tx_${fixture.reference}` } }), 1);
  });

  it('converges concurrent reconciliation attempts to one financial result', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await Promise.all([processor.process(eventFor(fixture.reference)), processor.process(eventFor(fixture.reference))]);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
  });

  it('rejects unknown references and provider identity conflicts', async () => {
    const gateway = new MockPaystackGateway();
    const first = await createFixture(gateway);
    const second = await createFixture(gateway);
    const firstProviderId = `mock_tx_${first.reference}`;
    gateway.setVerificationResult(second.reference, { reference: second.reference, providerTransactionId: firstProviderId, amountCents, currency: 'USD', status: 'success' });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await assertPermanent(processor.process(eventFor('rota-unknown-reference')));
    await processor.process(eventFor(first.reference));
    await assertPermanent(processor.process(eventFor(second.reference)));
    assert.equal((await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: second.attemptId } })).status, BillingPaymentAttemptStatus.PENDING);
  });

  it('rejects mismatched provider facts and metadata without financial changes', async () => {
    const cases: Array<{ name: string; result: VerifiedPayment | PaymentGatewayError; metadata?: Readonly<Record<string, string>> }> = [];
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    cases.push({ name: 'amount', result: { reference: fixture.reference, providerTransactionId: 'amount-mismatch', amountCents: 1_999, currency: 'USD', status: 'success' } });
    gateway.setVerificationResult(fixture.reference, cases[0].result);
    await assertPermanent(new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference)));
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);

    const currencyGateway = new MockPaystackGateway();
    const currencyFixture = await createFixture(currencyGateway);
    currencyGateway.setVerificationResult(currencyFixture.reference, { reference: currencyFixture.reference, providerTransactionId: 'currency-mismatch', amountCents, currency: 'NGN', status: 'success' });
    await assertPermanent(new PaystackReconciliationProcessor(prisma, currencyGateway).process(eventFor(currencyFixture.reference)));
    assert.equal((await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: currencyFixture.attemptId } })).status, BillingPaymentAttemptStatus.PENDING);

    const metadataGateway = new MockPaystackGateway();
    const metadataFixture = await createFixture(metadataGateway, { metadata: { mode: 'wrong', subscriptionId: metadataFixturePlaceholder() } });
    await assertPermanent(new PaystackReconciliationProcessor(prisma, metadataGateway).process(eventFor(metadataFixture.reference)));
    assert.equal((await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: metadataFixture.attemptId } })).status, BillingPaymentAttemptStatus.PENDING);
  });

  it('rejects a persisted plan or price identity mismatch without financial changes', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const idempotency = await prisma.billingIdempotencyKey.findUniqueOrThrow({ where: { id: fixture.idempotencyId } });
    const snapshot = idempotency.responseBody as Record<string, unknown>;
    await prisma.billingIdempotencyKey.update({
      where: { id: fixture.idempotencyId },
      data: { responseBody: { ...snapshot, priceId: randomUUID() } },
    });

    await assertPermanent(new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference)));
    const attempt = await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });
    assert.equal(attempt.status, BillingPaymentAttemptStatus.PENDING);
    assert.equal(invoice.status, BillingInvoiceStatus.DRAFT);
    assert.equal(invoice.amountPaidCents, 0);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
  });

  it('rejects a historical amount mismatch without financial changes', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    await useHistoricalPrice(fixture, { monthlyPriceCents: 1_900, includedStaffSeats: 0, extraStaffSeatPriceCents: 0, billableStaffSeats: 0 });

    await assertPermanent(new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference)));
    const attempt = await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });
    const subscription = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(attempt.status, BillingPaymentAttemptStatus.PENDING);
    assert.equal(invoice.status, BillingInvoiceStatus.DRAFT);
    assert.equal(invoice.amountPaidCents, 0);
    assert.equal(subscription.status, BillingSubscriptionStatus.PENDING_CHECKOUT);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
  });

  it('returns retryable failure for unsuccessful provider verification', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    gateway.simulateFailure(fixture.reference);
    await assert.rejects(
      new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference)),
      (error: unknown) => error instanceof RetryableWebhookError,
    );
    assert.equal((await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } })).status, BillingPaymentAttemptStatus.PENDING);
  });

  it('rolls back all financial changes when the transaction fails', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const failingDatabase = {
      ...prisma,
      billingPaymentAttempt: prisma.billingPaymentAttempt,
      $transaction: async (callback: (transaction: Prisma.TransactionClient) => Promise<unknown>, options: object) => prisma.$transaction((transaction) => callback({
        ...transaction,
        billingLedgerTransaction: {
          ...transaction.billingLedgerTransaction,
          create: async () => { throw new Error('synthetic ledger failure'); },
        },
      } as unknown as Prisma.TransactionClient), options as never),
    } as unknown as typeof prisma;
    await assert.rejects(new PaystackReconciliationProcessor(failingDatabase, gateway).process(eventFor(fixture.reference)), /synthetic ledger failure/);
    assert.equal((await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } })).status, BillingPaymentAttemptStatus.PENDING);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
  });

  it('does not modify already paid records on a late duplicate', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await processor.process(eventFor(fixture.reference));
    const before = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });
    await processor.process(eventFor(fixture.reference, { amount: 1 }));
    const after = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });
    assert.deepEqual(after, before);
  });

  it('activates cleanly without fabricating an ID when provider customer code is missing', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { providerCustomerId: null });
    assert.equal(fixture.providerCustomerId, undefined);
    await new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference));

    const subscription = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    const attempt = await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });

    assert.equal(subscription.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(subscription.providerCustomerId, null);
    assert.equal(attempt.status, BillingPaymentAttemptStatus.SUCCEEDED);
    assert.equal(invoice.status, BillingInvoiceStatus.PAID);
  });

  it('rejects an invalid provider customer code without activating or fabricating IDs', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    gateway.setVerificationResult(fixture.reference, {
      reference: fixture.reference,
      providerTransactionId: `mock_tx_${fixture.reference}`,
      providerCustomerId: 'INVALID_NO_PREFIX',
      amountCents,
      currency: 'USD',
      status: 'success',
    });

    await assertPermanent(new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(fixture.reference)));

    const subscription = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    const attempt = await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    assert.equal(subscription.status, BillingSubscriptionStatus.PENDING_CHECKOUT);
    assert.equal(subscription.providerCustomerId, null);
    assert.equal(attempt.status, BillingPaymentAttemptStatus.PENDING);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
  });

  it('is idempotent on replay with matching customer identity', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const processor = new PaystackReconciliationProcessor(prisma, gateway);

    await processor.process(eventFor(fixture.reference));
    const firstSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(firstSub.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(firstSub.providerCustomerId, fixture.providerCustomerId);

    await processor.process(eventFor(fixture.reference));
    const secondSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(secondSub.providerCustomerId, fixture.providerCustomerId);
    assert.equal(secondSub.version, firstSub.version);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
  });

  it('rejects replay when verified customer identity conflicts with existing subscription', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const processor = new PaystackReconciliationProcessor(prisma, gateway);

    await processor.process(eventFor(fixture.reference));
    const originalSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(originalSub.providerCustomerId, fixture.providerCustomerId);

    const conflictingCustomerCode = `CUS_conflict_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    gateway.setVerificationResult(fixture.reference, {
      reference: fixture.reference,
      providerTransactionId: `mock_tx_${fixture.reference}`,
      providerCustomerId: conflictingCustomerCode,
      amountCents,
      currency: 'USD',
      status: 'success',
    });

    await assertPermanent(processor.process(eventFor(fixture.reference)));

    const afterSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(afterSub.providerCustomerId, fixture.providerCustomerId);
    assert.notEqual(afterSub.providerCustomerId, conflictingCustomerCode);
  });

  it('rejects activation if provider customer code is already linked to another subscription', async () => {
    const gateway = new MockPaystackGateway();
    const sharedCustomerCode = `CUS_shared_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const firstFixture = await createFixture(gateway, { providerCustomerId: sharedCustomerCode });
    await new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(firstFixture.reference));

    const firstSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: firstFixture.subscriptionId } });
    assert.equal(firstSub.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(firstSub.providerCustomerId, sharedCustomerCode);

    const secondFixture = await createFixture(gateway, { providerCustomerId: sharedCustomerCode });
    await assertPermanent(new PaystackReconciliationProcessor(prisma, gateway).process(eventFor(secondFixture.reference)));

    const secondSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: secondFixture.subscriptionId } });
    assert.equal(secondSub.status, BillingSubscriptionStatus.PENDING_CHECKOUT);
    assert.equal(secondSub.providerCustomerId, null);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: secondFixture.subscriptionId } }), 0);
  });

  it('safely links verified provider subscription after charge.success reconciliation', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { recurring: true });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);

    await processor.process(eventFor(fixture.reference));
    const afterCharge = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(afterCharge.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(afterCharge.providerSubscriptionId, null);
    const initialVersion = afterCharge.version;

    const subCode = `SUB_link_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    gateway.registerMockSubscription({
      providerSubscriptionId: '1001',
      subscriptionCode: subCode,
      status: 'active',
      customerCode: fixture.providerCustomerId!,
      planCode: fixture.providerPlanCode!,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });

    await processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!));

    const afterLink = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(afterLink.providerSubscriptionId, subCode);
    assert.equal(afterLink.version, initialVersion + 1);
    assert.equal(afterLink.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
  });

  it('rejects subscription.create with missing or malformed customer hint as permanent error', async () => {
    const gateway = new MockPaystackGateway();
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    const subCode = `SUB_bad_cus_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

    await assertPermanent(processor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'subscription.create',
      payload: { event: 'subscription.create', data: { subscription_code: subCode } },
    }));

    await assertPermanent(processor.process({
      id: randomUUID(),
      provider: 'paystack',
      eventType: 'subscription.create',
      payload: { event: 'subscription.create', data: { subscription_code: subCode, customer: { customer_code: 'INVALID_NO_PREFIX' } } },
    }));
  });

  it('rejects subscription.create when customer has no matching recurring checkout', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { recurring: false });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await processor.process(eventFor(fixture.reference));

    const subCode = `SUB_no_rec_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    gateway.registerMockSubscription({
      providerSubscriptionId: '1002',
      subscriptionCode: subCode,
      status: 'active',
      customerCode: fixture.providerCustomerId!,
      planCode: 'PLN_unrelated_123',
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });

    await assertPermanent(processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!)));

    const sub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(sub.providerSubscriptionId, null);
  });

  it('rejects subscription.create on plan code or amount mismatch without linking', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { recurring: true });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await processor.process(eventFor(fixture.reference));

    const subCode = `SUB_mismatch_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

    await assertPermanent(processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!, {
      plan: { plan_code: 'PLN_mismatched_hint' },
    })));

    await assertPermanent(processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!, {
      amount: 99_999,
    })));

    gateway.setSubscriptionLookupResult(subCode, {
      providerSubscriptionId: '1003',
      subscriptionCode: subCode,
      status: 'active',
      customerCode: fixture.providerCustomerId!,
      planCode: 'PLN_wrong_plan_code_from_provider',
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });
    await assertPermanent(processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!)));

    const subCodeAmount = `SUB_amt_mismatch_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    gateway.setSubscriptionLookupResult(subCodeAmount, {
      providerSubscriptionId: '1004',
      subscriptionCode: subCodeAmount,
      status: 'active',
      customerCode: fixture.providerCustomerId!,
      planCode: fixture.providerPlanCode!,
      amountCents: 99_999,
      currency: 'USD',
      interval: 'monthly',
    });
    await assertPermanent(processor.process(subscriptionEventFor(subCodeAmount, fixture.providerCustomerId!)));

    const sub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(sub.providerSubscriptionId, null);
  });

  it('handles event ordering safely as retryable unresolved event before charge.success persists customer ID', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { recurring: true });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);

    const subCode = `SUB_order_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    const customerCode = fixture.providerCustomerId!;
    gateway.registerMockSubscription({
      providerSubscriptionId: '1005',
      subscriptionCode: subCode,
      status: 'active',
      customerCode,
      planCode: fixture.providerPlanCode!,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });

    const pendingSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(pendingSub.status, BillingSubscriptionStatus.PENDING_CHECKOUT);
    assert.equal(pendingSub.providerCustomerId, null);

    await assert.rejects(
      processor.process(subscriptionEventFor(subCode, customerCode)),
      (error: unknown) => error instanceof RetryableWebhookError
    );

    const stillPending = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(stillPending.providerSubscriptionId, null);
    assert.equal(stillPending.status, BillingSubscriptionStatus.PENDING_CHECKOUT);

    await processor.process(eventFor(fixture.reference));
    const activatedSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(activatedSub.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(activatedSub.providerCustomerId, customerCode);

    await processor.process(subscriptionEventFor(subCode, customerCode));
    const linkedSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(linkedSub.providerSubscriptionId, subCode);
  });

  it('is idempotent on duplicate subscription.create delivery', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { recurring: true });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await processor.process(eventFor(fixture.reference));

    const subCode = `SUB_dup_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    gateway.registerMockSubscription({
      providerSubscriptionId: '1006',
      subscriptionCode: subCode,
      status: 'active',
      customerCode: fixture.providerCustomerId!,
      planCode: fixture.providerPlanCode!,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });

    await processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!));
    const first = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(first.providerSubscriptionId, subCode);

    await processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!, { amount: 2000 }));
    const second = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(second.providerSubscriptionId, subCode);
    assert.equal(second.version, first.version);
  });

  it('rejects attempts to link a provider subscription already owned by another team or subscription', async () => {
    const gateway = new MockPaystackGateway();
    const firstFixture = await createFixture(gateway, { recurring: true });
    const secondFixture = await createFixture(gateway, { recurring: true });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);

    await processor.process(eventFor(firstFixture.reference));
    await processor.process(eventFor(secondFixture.reference));

    const sharedSubCode = `SUB_shared_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

    gateway.registerMockSubscription({
      providerSubscriptionId: '1007',
      subscriptionCode: sharedSubCode,
      status: 'active',
      customerCode: firstFixture.providerCustomerId!,
      planCode: firstFixture.providerPlanCode!,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });
    await processor.process(subscriptionEventFor(sharedSubCode, firstFixture.providerCustomerId!));

    const firstSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: firstFixture.subscriptionId } });
    assert.equal(firstSub.providerSubscriptionId, sharedSubCode);

    const diffSubCode = `SUB_diff_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    gateway.registerMockSubscription({
      providerSubscriptionId: '1008',
      subscriptionCode: diffSubCode,
      status: 'active',
      customerCode: firstFixture.providerCustomerId!,
      planCode: firstFixture.providerPlanCode!,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });
    await assertPermanent(processor.process(subscriptionEventFor(diffSubCode, firstFixture.providerCustomerId!)));

    gateway.registerMockSubscription({
      providerSubscriptionId: '1007',
      subscriptionCode: sharedSubCode,
      status: 'active',
      customerCode: secondFixture.providerCustomerId!,
      planCode: secondFixture.providerPlanCode!,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });
    await assertPermanent(processor.process(subscriptionEventFor(sharedSubCode, secondFixture.providerCustomerId!)));

    const secondSub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: secondFixture.subscriptionId } });
    assert.equal(secondSub.providerSubscriptionId, null);
  });

  it('returns retryable failure when provider verification suffers outage', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { recurring: true });
    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await processor.process(eventFor(fixture.reference));

    const subCode = `SUB_outage_${randomUUID().replace(/-/g, '').slice(0, 14)}`;

    gateway.setSubscriptionLookupResult(subCode, new PaymentGatewayError('TIMEOUT', 'Paystack request timed out'));
    await assert.rejects(
      processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!)),
      (error: unknown) => error instanceof RetryableWebhookError
    );

    gateway.setSubscriptionLookupResult(subCode, new PaymentGatewayError('NETWORK', 'Network connection reset'));
    await assert.rejects(
      processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!)),
      (error: unknown) => error instanceof RetryableWebhookError
    );

    gateway.setSubscriptionLookupResult(subCode, new PaymentGatewayError('PROVIDER_FAILURE', 'Paystack returned HTTP 500'));
    await assert.rejects(
      processor.process(subscriptionEventFor(subCode, fixture.providerCustomerId!)),
      (error: unknown) => error instanceof RetryableWebhookError
    );

    const sub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(sub.providerSubscriptionId, null);
  });

  it('does not activate a Rota subscription or alter ledger based solely on subscription.create', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway, { recurring: true });
    const customerCode = fixture.providerCustomerId!;

    await prisma.billingSubscription.update({
      where: { id: fixture.subscriptionId },
      data: { providerCustomerId: customerCode },
    });

    const subCode = `SUB_no_act_${randomUUID().replace(/-/g, '').slice(0, 14)}`;
    gateway.registerMockSubscription({
      providerSubscriptionId: '1009',
      subscriptionCode: subCode,
      status: 'active',
      customerCode,
      planCode: fixture.providerPlanCode!,
      amountCents,
      currency: 'USD',
      interval: 'monthly',
    });

    const processor = new PaystackReconciliationProcessor(prisma, gateway);
    await processor.process(subscriptionEventFor(subCode, customerCode));

    const sub = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    assert.equal(sub.providerSubscriptionId, subCode);
    assert.equal(sub.status, BillingSubscriptionStatus.PENDING_CHECKOUT);
    assert.equal(sub.currentPeriodStart, null);
    assert.equal(sub.currentPeriodEnd, null);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
  });
});

const metadataFixturePlaceholder = (): string => 'not-the-trusted-subscription-id';
