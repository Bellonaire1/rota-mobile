-- Add nullable checkout identity fields without changing existing billing data.
ALTER TABLE "BillingPaymentAttempt"
  ADD COLUMN "providerReference" VARCHAR(255),
  ADD COLUMN "idempotencyKeyId" TEXT;

CREATE UNIQUE INDEX "BillingPaymentAttempt_providerReference_key"
  ON "BillingPaymentAttempt"("providerReference");

CREATE UNIQUE INDEX "BillingPaymentAttempt_idempotencyKeyId_key"
  ON "BillingPaymentAttempt"("idempotencyKeyId");

ALTER TABLE "BillingPaymentAttempt"
  ADD CONSTRAINT "BillingPaymentAttempt_idempotencyKeyId_fkey"
  FOREIGN KEY ("idempotencyKeyId")
  REFERENCES "BillingIdempotencyKey"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
