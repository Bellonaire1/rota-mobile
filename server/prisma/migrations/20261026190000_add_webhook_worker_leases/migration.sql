-- Add durable retry scheduling and worker lease fencing without changing
-- existing webhook payloads, statuses, attempts, or uniqueness constraints.
ALTER TABLE "BillingWebhookEvent"
    ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "processingLeaseUntil" TIMESTAMPTZ(3),
    ADD COLUMN "processingLeaseToken" VARCHAR(128);

-- Existing RECEIVED rows get the current timestamp from the column default and
-- are therefore immediately eligible for a worker claim. Existing PROCESSING
-- rows retain their status and NULL lease metadata. A future worker cutover
-- must explicitly requeue those legacy rows to RECEIVED after review; this
-- migration intentionally does not overwrite or mark any event processed.
CREATE INDEX "BillingWebhookEvent_status_nextAttemptAt_idx"
    ON "BillingWebhookEvent"("status", "nextAttemptAt");

CREATE INDEX "BillingWebhookEvent_status_processingLeaseUntil_idx"
    ON "BillingWebhookEvent"("status", "processingLeaseUntil");
