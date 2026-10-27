import { randomBytes } from 'node:crypto';
import { BillingWebhookEventStatus, PrismaClient } from '@prisma/client';

export type WebhookWorkItem = {
  id: string;
  provider: string;
  eventType: string;
  payload: unknown;
  attemptCount: number;
  processingLeaseToken: string;
  processingLeaseUntil: Date;
};

type ClaimedRow = Omit<WebhookWorkItem, 'payload'> & { payload: unknown };

export type FailureTransition = {
  status: BillingWebhookEventStatus;
  nextAttemptAt: Date;
  lastError: string;
};

export class WebhookEventQueue {
  constructor(private readonly database: PrismaClient) {}

  async countLegacyProcessingEvents(): Promise<number> {
    const rows = await this.database.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "BillingWebhookEvent"
      WHERE "status" = ${BillingWebhookEventStatus.PROCESSING}::"BillingWebhookEventStatus"
        AND ("processingLeaseToken" IS NULL OR "processingLeaseUntil" IS NULL)
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async claimOne(leaseDurationMs: number, provider?: string, eventType?: string): Promise<WebhookWorkItem | null> {
    const token = randomBytes(32).toString('hex');
    const rows = await this.database.$transaction(async (transaction) => transaction.$queryRaw<ClaimedRow[]>`
      WITH candidate AS (
        SELECT "id"
        FROM "BillingWebhookEvent"
        WHERE (
          (
            "status" = ${BillingWebhookEventStatus.RECEIVED}::"BillingWebhookEventStatus"
            AND "nextAttemptAt" <= CURRENT_TIMESTAMP
          ) OR (
            "status" = ${BillingWebhookEventStatus.PROCESSING}::"BillingWebhookEventStatus"
            AND "processingLeaseUntil" IS NOT NULL
            AND "processingLeaseUntil" <= CURRENT_TIMESTAMP
          )
        )
        AND (${provider ?? null}::text IS NULL OR "provider" = ${provider ?? null})
        AND (${eventType ?? null}::text IS NULL OR "eventType" = ${eventType ?? null})
        ORDER BY "nextAttemptAt" ASC, "receivedAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE "BillingWebhookEvent" AS event
      SET "status" = ${BillingWebhookEventStatus.PROCESSING}::"BillingWebhookEventStatus",
          "attemptCount" = event."attemptCount" + 1,
          "processingLeaseUntil" = CURRENT_TIMESTAMP + (${leaseDurationMs} * INTERVAL '1 millisecond'),
          "processingLeaseToken" = ${token},
          "updatedAt" = CURRENT_TIMESTAMP
      FROM candidate
      WHERE event."id" = candidate."id"
      RETURNING event."id", event."provider", event."eventType", event."payload",
        event."attemptCount", event."processingLeaseToken", event."processingLeaseUntil"
    `);

    const row = rows[0];
    if (!row || !row.processingLeaseToken || !row.processingLeaseUntil) return null;
    return { ...row, processingLeaseToken: row.processingLeaseToken, processingLeaseUntil: row.processingLeaseUntil };
  }

  async markProcessed(event: WebhookWorkItem): Promise<boolean> {
    const result = await this.database.billingWebhookEvent.updateMany({
      where: {
        id: event.id,
        status: BillingWebhookEventStatus.PROCESSING,
        processingLeaseToken: event.processingLeaseToken,
        processingLeaseUntil: { gt: new Date() },
      },
      data: {
        status: BillingWebhookEventStatus.PROCESSED,
        processedAt: new Date(),
        processingLeaseUntil: null,
        processingLeaseToken: null,
        lastError: null,
      },
    });
    return result.count === 1;
  }

  async markFailed(event: WebhookWorkItem, transition: FailureTransition): Promise<boolean> {
    const result = await this.database.billingWebhookEvent.updateMany({
      where: {
        id: event.id,
        status: BillingWebhookEventStatus.PROCESSING,
        processingLeaseToken: event.processingLeaseToken,
        processingLeaseUntil: { gt: new Date() },
      },
      data: {
        status: transition.status,
        nextAttemptAt: transition.nextAttemptAt,
        lastError: transition.lastError,
        processingLeaseUntil: null,
        processingLeaseToken: null,
        ...(transition.status === BillingWebhookEventStatus.FAILED ? { processedAt: null } : {}),
      },
    });
    return result.count === 1;
  }
}
