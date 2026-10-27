import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, describe, it } from 'node:test';
import { BillingWebhookEventStatus } from '@prisma/client';
import { prisma } from '../database/prisma';
import { WebhookEventQueue } from './webhook-event-queue';
import { PermanentWebhookError, RetryableWebhookError, WebhookProcessorNotConfiguredError, type WebhookEventProcessor } from './webhook-event-processor';
import { retryDelayMs, startWebhookWorker, WebhookWorker, type WebhookWorkerConfig } from './webhook-worker';

const fixtureIds: string[] = [];
const config: WebhookWorkerConfig = {
  provider: 'synthetic-test',
  pollIntervalMs: 1,
  leaseDurationMs: 60_000,
  maxAttempts: 3,
  batchSize: 10,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 10_000,
  retryJitterRatio: 0.2,
};

const createEvent = async (data: { status?: BillingWebhookEventStatus; nextAttemptAt?: Date; attemptCount?: number } = {}) => {
  const event = await prisma.billingWebhookEvent.create({
    data: {
      provider: 'synthetic-test',
      providerEventId: randomUUID(),
      eventType: `synthetic.${randomUUID()}`,
      payload: { synthetic: true },
      signatureVerifiedAt: new Date(),
      status: data.status ?? BillingWebhookEventStatus.RECEIVED,
      nextAttemptAt: data.nextAttemptAt ?? new Date(Date.now() - 1_000),
      attemptCount: data.attemptCount,
    },
  });
  fixtureIds.push(event.id);
  return event;
};

const successfulProcessor = (calls: string[] = []): WebhookEventProcessor => ({
  process: async (event) => { calls.push(event.id); },
});

describe('durable webhook worker', { concurrency: false }, () => {
  before(async () => {
    const legacy = await new WebhookEventQueue(prisma).countLegacyProcessingEvents();
    assert.equal(legacy, 0, 'test database contains legacy PROCESSING rows requiring manual review');
  });

  after(async () => {
    await prisma.billingWebhookEvent.deleteMany({ where: { id: { in: fixtureIds } } });
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.billingWebhookEvent.deleteMany({ where: { id: { in: fixtureIds } } });
    fixtureIds.length = 0;
  });

  it('claims only due RECEIVED events and increments the attempt count', async () => {
    const future = await createEvent({ nextAttemptAt: new Date(Date.now() + 60_000) });
    const due = await createEvent({ nextAttemptAt: new Date(Date.now() - 1_000) });
    const queue = new WebhookEventQueue(prisma);

    const claimed = await queue.claimOne(config.leaseDurationMs, config.provider);
    assert.equal(claimed?.id, due.id);
    assert.equal(claimed?.attemptCount, 1);
    assert.notEqual(claimed?.processingLeaseToken, null);
    assert.equal(await queue.claimOne(config.leaseDurationMs, config.provider), null);
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: future.id } })).status, BillingWebhookEventStatus.RECEIVED);
  });

  it('prevents two simultaneous workers from claiming one event', async () => {
    const event = await createEvent({ nextAttemptAt: new Date(Date.now() - 1_000) });
    const queueA = new WebhookEventQueue(prisma);
    const queueB = new WebhookEventQueue(prisma);
    const claims = await Promise.all([queueA.claimOne(config.leaseDurationMs, config.provider), queueB.claimOne(config.leaseDurationMs, config.provider)]);
    assert.equal(claims.filter((claim) => claim?.id === event.id).length, 1);
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } })).attemptCount, 1);
  });

  it('transitions a successful synthetic event to PROCESSED', async () => {
    const event = await createEvent();
    const worker = new WebhookWorker(new WebhookEventQueue(prisma), successfulProcessor(), config);
    assert.equal(await worker.runOnce(), 1);
    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(stored.status, BillingWebhookEventStatus.PROCESSED);
    assert.equal(stored.processingLeaseToken, null);
    assert.notEqual(stored.processedAt, null);
  });

  it('schedules retryable failures with bounded exponential jitter', async () => {
    const event = await createEvent();
    const worker = new WebhookWorker(new WebhookEventQueue(prisma), {
      process: async () => { throw new RetryableWebhookError('temporary provider outage'); },
    }, config);
    const before = Date.now();
    assert.equal(await worker.runOnce(), 1);
    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(stored.status, BillingWebhookEventStatus.RECEIVED);
    assert.equal(stored.attemptCount, 1);
    assert.equal(stored.lastError, 'temporary provider outage');
    assert.ok(stored.nextAttemptAt.getTime() >= before + 80);
    assert.ok(stored.nextAttemptAt.getTime() <= before + 10_000);
  });

  it('uses bounded exponential backoff and jitter', () => {
    assert.equal(retryDelayMs(1, config, () => 0), 80);
    assert.equal(retryDelayMs(2, config, () => 0.5), 200);
    assert.equal(retryDelayMs(20, config, () => 1), config.retryMaxDelayMs);
  });

  it('marks permanent and exhausted failures as terminal FAILED', async () => {
    const permanent = await createEvent();
    const exhausted = await createEvent({ attemptCount: config.maxAttempts - 1 });
    const worker = new WebhookWorker(new WebhookEventQueue(prisma), {
      process: async (event) => {
        if (event.id === permanent.id) throw new PermanentWebhookError('unsupported synthetic event');
        throw new RetryableWebhookError('retry limit reached');
      },
    }, config);
    assert.equal(await worker.runOnce(), 2);
    const storedPermanent = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: permanent.id } });
    const storedExhausted = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: exhausted.id } });
    assert.equal(storedPermanent.status, BillingWebhookEventStatus.FAILED);
    assert.equal(storedExhausted.status, BillingWebhookEventStatus.FAILED);
    assert.equal(storedExhausted.attemptCount, config.maxAttempts);
  });

  it('reclaims expired leased work with a fresh token', async () => {
    const event = await createEvent({ status: BillingWebhookEventStatus.PROCESSING });
    const oldToken = 'old-token';
    await prisma.billingWebhookEvent.update({
      where: { id: event.id },
      data: { processingLeaseToken: oldToken, processingLeaseUntil: new Date(Date.now() - 1_000), attemptCount: 1 },
    });
    const reclaimed = await new WebhookEventQueue(prisma).claimOne(config.leaseDurationMs, config.provider);
    assert.equal(reclaimed?.id, event.id);
    assert.notEqual(reclaimed?.processingLeaseToken, oldToken);
    assert.equal(reclaimed?.attemptCount, 2);
  });

  it('fences stale completion after lease reclamation', async () => {
    const event = await createEvent();
    const queue = new WebhookEventQueue(prisma);
    const stale = await queue.claimOne(config.leaseDurationMs, config.provider);
    assert.ok(stale);
    await prisma.billingWebhookEvent.update({ where: { id: event.id }, data: { processingLeaseUntil: new Date(Date.now() - 1_000) } });
    const current = await queue.claimOne(config.leaseDurationMs, config.provider);
    assert.ok(current);
    assert.equal(await queue.markProcessed(stale), false);
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } })).status, BillingWebhookEventStatus.PROCESSING);
    assert.equal(await queue.markProcessed(current), true);
  });

  it('does not mark a slow handler processed after its lease expires', async () => {
    const event = await createEvent();
    const worker = new WebhookWorker(new WebhookEventQueue(prisma), {
      process: async () => {
        await prisma.billingWebhookEvent.update({
          where: { id: event.id },
          data: { processingLeaseUntil: new Date(Date.now() - 1_000) },
        });
      },
    }, config);
    assert.equal(await worker.runOnce(), 1);
    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(stored.status, BillingWebhookEventStatus.PROCESSING);
    assert.equal(stored.processedAt, null);
  });

  it('preserves scheduled work across worker instances', async () => {
    const event = await createEvent({ nextAttemptAt: new Date(Date.now() + 60_000) });
    const queue = new WebhookEventQueue(prisma);
    const firstWorker = new WebhookWorker(queue, successfulProcessor(), config);
    assert.equal(await firstWorker.runOnce(), 0);
    await prisma.billingWebhookEvent.update({ where: { id: event.id }, data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    const calls: string[] = [];
    const restartedWorker = new WebhookWorker(queue, successfulProcessor(calls), config);
    assert.equal(await restartedWorker.runOnce(), 1);
    assert.deepEqual(calls, [event.id]);
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } })).status, BillingWebhookEventStatus.PROCESSED);
  });

  it('continues processing other events after one failure', async () => {
    const failed = await createEvent();
    const succeeded = await createEvent();
    const calls: string[] = [];
    const worker = new WebhookWorker(new WebhookEventQueue(prisma), {
      process: async (event) => {
        calls.push(event.id);
        if (event.id === failed.id) throw new PermanentWebhookError('not supported');
      },
    }, { ...config, batchSize: 2 });
    assert.equal(await worker.runOnce(), 2);
    assert.deepEqual(calls.sort(), [failed.id, succeeded.id].sort());
    assert.equal((await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: succeeded.id } })).status, BillingWebhookEventStatus.PROCESSED);
  });

  it('refuses startup before claiming genuine Paystack events', async () => {
    const event = await prisma.billingWebhookEvent.create({
      data: {
        provider: 'paystack',
        providerEventId: randomUUID(),
        eventType: `charge.success.worker.${randomUUID()}`,
        payload: { event: 'charge.success', data: { reference: randomUUID() } },
        signatureVerifiedAt: new Date(),
      },
    });
    fixtureIds.push(event.id);
    await assert.rejects(
      startWebhookWorker(prisma),
      (error: unknown) => error instanceof WebhookProcessorNotConfiguredError
        && error.message.includes('genuine Paystack events remain RECEIVED'),
    );
    const stored = await prisma.billingWebhookEvent.findUniqueOrThrow({ where: { id: event.id } });
    assert.equal(stored.status, BillingWebhookEventStatus.RECEIVED);
    assert.equal(stored.attemptCount, 0);
    assert.equal(stored.processedAt, null);
  });
});
