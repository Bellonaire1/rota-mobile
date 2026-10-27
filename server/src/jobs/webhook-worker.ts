import { BillingWebhookEventStatus, PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../database/prisma';
import { WebhookEventQueue, type WebhookWorkItem } from './webhook-event-queue';
import { assertApprovedWebhookProcessor, FailClosedWebhookEventProcessor, PermanentWebhookError, RetryableWebhookError, type WebhookEventProcessor } from './webhook-event-processor';

export type WebhookWorkerConfig = {
  provider?: string;
  eventType?: string;
  pollIntervalMs: number;
  leaseDurationMs: number;
  maxAttempts: number;
  batchSize: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterRatio: number;
};

export const webhookWorkerConfig: WebhookWorkerConfig = {
  pollIntervalMs: env.WEBHOOK_WORKER_POLL_INTERVAL_MS,
  leaseDurationMs: env.WEBHOOK_WORKER_LEASE_DURATION_MS,
  maxAttempts: env.WEBHOOK_WORKER_MAX_ATTEMPTS,
  batchSize: env.WEBHOOK_WORKER_BATCH_SIZE,
  retryBaseDelayMs: env.WEBHOOK_WORKER_RETRY_BASE_DELAY_MS,
  retryMaxDelayMs: env.WEBHOOK_WORKER_RETRY_MAX_DELAY_MS,
  retryJitterRatio: env.WEBHOOK_WORKER_RETRY_JITTER_RATIO,
};

export const retryDelayMs = (
  attemptCount: number,
  config: Pick<WebhookWorkerConfig, 'retryBaseDelayMs' | 'retryMaxDelayMs' | 'retryJitterRatio'>,
  random = Math.random,
): number => {
  const exponential = Math.min(config.retryMaxDelayMs, config.retryBaseDelayMs * (2 ** Math.max(0, attemptCount - 1)));
  const jittered = exponential * (1 - config.retryJitterRatio + (random() * 2 * config.retryJitterRatio));
  return Math.min(config.retryMaxDelayMs, Math.max(0, Math.round(jittered)));
};

export const sanitizeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1_000) || 'Webhook processing failed';
};

export class WebhookWorker {
  private stopping = false;

  constructor(
    private readonly queue: WebhookEventQueue,
    private readonly processor: WebhookEventProcessor,
    private readonly config: WebhookWorkerConfig,
    private readonly logger: Pick<Console, 'error' | 'info' | 'warn'> = console,
  ) {}

  stop(): void {
    this.stopping = true;
  }

  async runOnce(): Promise<number> {
    const claims: WebhookWorkItem[] = [];
    for (let index = 0; index < this.config.batchSize; index += 1) {
      const event = await this.queue.claimOne(this.config.leaseDurationMs, this.config.provider, this.config.eventType);
      if (!event) break;
      claims.push(event);
    }
    for (const event of claims) await this.processClaim(event);
    return claims.length;
  }

  async run(): Promise<void> {
    while (!this.stopping) {
      const claimed = await this.runOnce();
      if (claimed === 0) await this.delay(this.config.pollIntervalMs);
    }
  }

  private async processClaim(event: WebhookWorkItem): Promise<void> {
    try {
      // There is no heartbeat. Handlers must finish within the lease window;
      // an expired lease is fenced by the token- and status-conditional write.
      await this.processor.process(event);
      if (!(await this.queue.markProcessed(event))) {
        this.logger.warn(`[WebhookWorker] Completion fenced for event ${event.id}`);
      }
    } catch (error) {
      const terminal = error instanceof PermanentWebhookError || event.attemptCount >= this.config.maxAttempts;
      const status = terminal ? BillingWebhookEventStatus.FAILED : BillingWebhookEventStatus.RECEIVED;
      const nextAttemptAt = terminal
        ? new Date()
        : new Date(Date.now() + retryDelayMs(event.attemptCount, this.config));
      const transitioned = await this.queue.markFailed(event, {
        status,
        nextAttemptAt,
        lastError: sanitizeError(error),
      });
      if (!transitioned) {
        this.logger.warn(`[WebhookWorker] Failure transition fenced for event ${event.id}`);
      } else {
        this.logger.error(`[WebhookWorker] ${status === BillingWebhookEventStatus.FAILED ? 'Terminal' : 'Retryable'} failure for event ${event.id}`);
      }
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

const assertNoLegacyProcessingEvents = async (queue: WebhookEventQueue): Promise<void> => {
  const count = await queue.countLegacyProcessingEvents();
  if (count > 0) throw new Error(`Refusing to start: ${count} legacy PROCESSING webhook event(s) have no lease metadata`);
};

export const startWebhookWorker = async (
  database: PrismaClient = prisma,
  processor: WebhookEventProcessor = new FailClosedWebhookEventProcessor(),
  config: WebhookWorkerConfig = webhookWorkerConfig,
): Promise<void> => {
  assertApprovedWebhookProcessor(processor);
  const queue = new WebhookEventQueue(database);
  await assertNoLegacyProcessingEvents(queue);
  const worker = new WebhookWorker(queue, processor, config);
  const shutdown = () => worker.stop();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    console.info('[WebhookWorker] Started with durable PostgreSQL queue');
    await worker.run();
  } finally {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  }
};

if (require.main === module) {
  startWebhookWorker()
    .catch((error: unknown) => {
      console.error(`[WebhookWorker] ${sanitizeError(error)}`);
      process.exitCode = 1;
    })
    .finally(async () => prisma.$disconnect());
}
