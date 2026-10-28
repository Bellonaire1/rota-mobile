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

const createFixture = async (
  gateway: MockPaystackGateway,
  options: {
    metadata?: Readonly<Record<string, string>>;
    providerCustomerId?: string | null;
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
    data: { responseBody: { state: 'CHECKOUT_PENDING', subscriptionId: subscription.id, invoiceId: invoice.id, paymentAttemptId: attempt.id, providerReference: reference, planCode: 'STARTER', priceId: price.id, billableStaffSeats: 0, amountCents, currency: 'USD' } },
  });
  await gateway.initializeTransaction({
    amountCents,
    currency: 'USD',
    customerEmail: user.email,
    reference,
    idempotencyKey: idempotency.key,
    metadata: options.metadata ?? { mode: 'test', subscriptionId: subscription.id },
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
});

const metadataFixturePlaceholder = (): string => 'not-the-trusted-subscription-id';
