import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  BillingInvoiceStatus,
  BillingLedgerTransactionStatus,
  BillingPaymentAttemptStatus,
  BillingSubscriptionStatus,
} from '@prisma/client';
import { env } from '../config/env';
import { MockPaystackGateway, PaymentGatewayError, type VerifyPaymentInput, type VerifiedPayment } from '../billing/payments';
import { prisma } from '../database/prisma';
import { PaystackWebhookService } from '../services/paystack-webhook.service';
import { reconciliationIntegrationSkipReason } from '../services/reconciliation-test-safety';
import { WebhookEventQueue } from './webhook-event-queue';
import { createPaystackReconciliationWorker, type WebhookWorkerConfig } from './webhook-worker';

type Fixture = {
  subscriptionId: string;
  invoiceId: string;
  attemptId: string;
  reference: string;
};

const amountCents = 2_000;
const webhookSecret = 'webhook-reconciliation-test-secret';
const workerConfig: WebhookWorkerConfig = {
  provider: 'paystack',
  eventType: 'charge.success',
  pollIntervalMs: 1,
  leaseDurationMs: 60_000,
  maxAttempts: 3,
  batchSize: 1,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 10_000,
  retryJitterRatio: 0,
};

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const signedBody = (body: string): string => createHmac('sha512', webhookSecret).update(Buffer.from(body)).digest('hex');

const receive = async (body: string): Promise<string> => {
  await new PaystackWebhookService(prisma).receive(Buffer.from(body), signedBody(body));
  const eventType = (JSON.parse(body) as { event: string }).event;
  const providerEventId = `${eventType}:${createHash('sha256').update(Buffer.from(body)).digest('hex')}`;
  const event = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'paystack', providerEventId } } });
  await prisma.billingWebhookEvent.update({ where: { id: event.id }, data: { nextAttemptAt: new Date(0) } });
  return event.id;
};

const createFixture = async (gateway: MockPaystackGateway): Promise<Fixture> => {
  const user = await prisma.user.create({
    data: { email: `worker-reconciliation-${randomUUID()}@example.com`, name: 'Worker Reconciliation Test', passwordHash: 'test-hash' },
  });
  const team = await prisma.team.create({ data: { name: `Worker Reconciliation Team ${randomUUID()}`, createdByUserId: user.id } });
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
      key: `worker-reconcile-${randomUUID()}`,
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
      idempotencyKey: `worker-reconcile-attempt-${randomUUID()}`,
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
    metadata: { mode: 'test', subscriptionId: subscription.id },
  });
  gateway.simulateSuccess(reference);
  return { subscriptionId: subscription.id, invoiceId: invoice.id, attemptId: attempt.id, reference };
};

const eventBody = (reference: string, data: Record<string, unknown> = {}): string => JSON.stringify({ event: 'charge.success', data: { reference, ...data } });

const configSince = (receivedAfter: Date): WebhookWorkerConfig => ({ ...workerConfig, receivedAfter });

describe('signed webhook to reconciliation worker pipeline', { concurrency: false, skip: reconciliationIntegrationSkipReason() }, () => {
  before(() => {
    env.PAYSTACK_TEST_SECRET_KEY = webhookSecret;
  });

  after(async () => prisma.$disconnect());

  it('persists, claims, reconciles, and marks a signed charge.success processed', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const body = eventBody(fixture.reference);
    const receivedAfter = new Date();
    const eventId = await receive(body);

    const received = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(received.status, 'RECEIVED');
    assert.equal(received.attemptCount, 0);

    const worker = createPaystackReconciliationWorker(prisma, gateway, configSince(receivedAfter));
    assert.equal(await worker.runOnce(), 1);

    const event = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: received.id } });
    const attempt = await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } });
    const invoice = await prisma.billingInvoice.findUniqueOrThrow({ where: { id: fixture.invoiceId } });
    const subscription = await prisma.billingSubscription.findUniqueOrThrow({ where: { id: fixture.subscriptionId } });
    const period = await prisma.billingPeriod.findFirstOrThrow({ where: { subscriptionId: fixture.subscriptionId } });
    const ledger = await prisma.billingLedgerTransaction.findFirstOrThrow({ where: { subscriptionId: fixture.subscriptionId } });
    const entries = await prisma.billingLedgerEntry.findMany({ where: { transactionId: ledger.id } });

    assert.equal(event.status, 'PROCESSED');
    assert.equal(attempt.status, BillingPaymentAttemptStatus.SUCCEEDED);
    assert.equal(invoice.status, BillingInvoiceStatus.PAID);
    assert.equal(subscription.status, BillingSubscriptionStatus.ACTIVE);
    assert.equal(period.totalAmountCents, amountCents);
    assert.equal(ledger.status, BillingLedgerTransactionStatus.POSTED);
    assert.equal(ledger.totalDebitCents, amountCents);
    assert.equal(ledger.totalCreditCents, amountCents);
    assert.equal(entries.length, 2);
  });

  it('rejects invalid signatures before queue persistence', async () => {
    const eventType = `charge.success.invalid.${randomUUID()}`;
    const body = JSON.stringify({ event: eventType, data: { reference: `invalid-${randomUUID()}` } });
    await assert.rejects(
      new PaystackWebhookService(prisma).receive(Buffer.from(body), '00'.repeat(64)),
      (error: unknown) => error instanceof Error && (error as Error & { statusCode?: number }).statusCode === 401,
    );
    assert.equal(await prisma.billingWebhookEvent.count({ where: { eventType } }), 0);
  });

  it('deduplicates deliveries and differently serialized events into one financial result', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const receivedAfter = new Date();
    const first = eventBody(fixture.reference);
    const differentlySerialized = `{ "event": "charge.success", "data": { "reference": "${fixture.reference}" } }`;
    const firstId = await receive(first);
    await receive(first);
    const secondId = await receive(differentlySerialized);

    const worker = createPaystackReconciliationWorker(prisma, gateway, configSince(receivedAfter));
    assert.equal(await worker.runOnce(), 1);
    assert.equal(await worker.runOnce(), 1);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: firstId } })).status, 'PROCESSED');
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: secondId } })).status, 'PROCESSED');
  });

  it('allows two workers to race safely on one payment', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const receivedAfter = new Date();
    await receive(eventBody(fixture.reference));
    const scopedConfig = configSince(receivedAfter);
    const workerA = createPaystackReconciliationWorker(prisma, gateway, scopedConfig);
    const workerB = createPaystackReconciliationWorker(prisma, gateway, scopedConfig);
    const claims = await Promise.all([workerA.runOnce(), workerB.runOnce()]);

    assert.deepEqual(claims.sort(), [0, 1]);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
  });

  it('schedules provider timeouts, then recovers on worker restart', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const receivedAfter = new Date();
    gateway.setVerificationResult(fixture.reference, new PaymentGatewayError('TIMEOUT', 'synthetic timeout'));
    const eventId = await receive(eventBody(fixture.reference));
    const worker = createPaystackReconciliationWorker(prisma, gateway, configSince(receivedAfter));
    assert.equal(await worker.runOnce(), 1);
    const retry = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(retry.status, 'RECEIVED');
    assert.equal(retry.attemptCount, 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);

    gateway.simulateSuccess(fixture.reference);
    await prisma.billingWebhookEvent.update({ where: { id: retry.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    assert.equal(await createPaystackReconciliationWorker(prisma, gateway, configSince(receivedAfter)).runOnce(), 1);
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: retry.id } })).status, 'PROCESSED');
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
  });

  it('marks provider mismatches terminal without financial posting', async () => {
    const gateway = new MockPaystackGateway();
    const fixture = await createFixture(gateway);
    const receivedAfter = new Date();
    gateway.setVerificationResult(fixture.reference, {
      reference: fixture.reference,
      providerTransactionId: `mismatch-${randomUUID()}`,
      amountCents: amountCents - 1,
      currency: 'USD',
      status: 'success',
    });
    const eventId = await receive(eventBody(fixture.reference));
    assert.equal(await createPaystackReconciliationWorker(prisma, gateway, configSince(receivedAfter)).runOnce(), 1);
    const event = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(event.status, 'FAILED');
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 0);
    assert.equal((await prisma.billingPaymentAttempt.findUniqueOrThrow({ where: { id: fixture.attemptId } })).status, BillingPaymentAttemptStatus.PENDING);
  });

  it('leaves unsupported signed events RECEIVED and unclaimed', async () => {
    const eventType = `invoice.create.${randomUUID()}`;
    const body = JSON.stringify({ event: eventType, data: { reference: `unsupported-${randomUUID()}` } });
    const receivedAfter = new Date();
    const eventId = await receive(body);
    const event = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(await createPaystackReconciliationWorker(prisma, new MockPaystackGateway(), configSince(receivedAfter)).runOnce(), 0);
    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(stored.status, 'RECEIVED');
    assert.equal(stored.attemptCount, 0);
  });

  it('fences a slow reconciliation after lease expiry and keeps one posting', async () => {
    class SlowMockGateway extends MockPaystackGateway {
      async verifyTransaction(input: VerifyPaymentInput): Promise<VerifiedPayment> {
        await wait(150);
        return super.verifyTransaction(input);
      }
    }
    const gateway = new SlowMockGateway();
    const fixture = await createFixture(gateway);
    const receivedAfter = new Date();
    await receive(eventBody(fixture.reference));
    const shortLease = { ...configSince(receivedAfter), leaseDurationMs: 50 };
    const first = createPaystackReconciliationWorker(prisma, gateway, shortLease).runOnce();
    await wait(75);
    const second = createPaystackReconciliationWorker(prisma, gateway, shortLease).runOnce();
    await Promise.all([first, second]);
    assert.equal(await prisma.billingPeriod.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
    assert.equal(await prisma.billingLedgerTransaction.count({ where: { subscriptionId: fixture.subscriptionId } }), 1);
  });

  it('keeps the executable worker fail-closed without an approved processor', async () => {
    const queue = new WebhookEventQueue(prisma);
    assert.equal(await queue.countLegacyProcessingEvents(), 0);
    const event = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'paystack',
        providerEventId: `guard-${randomUUID()}`,
        eventType: 'charge.success',
        payload: { event: 'charge.success', data: { reference: `guard-${randomUUID()}` } },
        signatureVerifiedAt: new Date(),
      },
    });
    await prisma.billingWebhookEvent.update({ where: { id: event.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    const { startWebhookWorker } = await import('./webhook-worker');
    await assert.rejects(startWebhookWorker(prisma, undefined, { ...workerConfig, batchSize: 1 }), /approved payment-reconciliation processor/);
    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(stored.status, 'RECEIVED');
    assert.equal(stored.attemptCount, 0);
  });
});
