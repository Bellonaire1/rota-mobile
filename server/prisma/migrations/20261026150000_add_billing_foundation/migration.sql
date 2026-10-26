-- CreateEnum
CREATE TYPE "BillingPlanCode" AS ENUM ('STARTER', 'TEAM', 'BUSINESS');

-- CreateEnum
CREATE TYPE "BillingSubscriptionStatus" AS ENUM ('PENDING_CHECKOUT', 'ACTIVE', 'PAST_DUE', 'GRACE', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "BillingPeriodStatus" AS ENUM ('OPEN', 'FINALIZED', 'VOID');

-- CreateEnum
CREATE TYPE "BillingInvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'PAYMENT_FAILED', 'VOID', 'UNCOLLECTIBLE');

-- CreateEnum
CREATE TYPE "BillingPaymentAttemptStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingWebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingIdempotencyStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingLedgerTransactionType" AS ENUM ('INVOICE', 'PAYMENT', 'REFUND', 'CREDIT', 'PRORATION');

-- CreateEnum
CREATE TYPE "BillingLedgerTransactionStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateTable
CREATE TABLE "BillingPlan" (
    "id" TEXT NOT NULL,
    "code" "BillingPlanCode" NOT NULL,
    "displayName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPlanPrice" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "monthlyPriceCents" INTEGER NOT NULL,
    "includedStaffSeats" INTEGER NOT NULL,
    "extraStaffSeatPriceCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(3),
    "providerPriceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPlanPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSubscription" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "priceId" TEXT NOT NULL,
    "status" "BillingSubscriptionStatus" NOT NULL DEFAULT 'PENDING_CHECKOUT',
    "provider" VARCHAR(32),
    "providerCustomerId" VARCHAR(255),
    "providerSubscriptionId" VARCHAR(255),
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "currentPeriodStart" TIMESTAMPTZ(3),
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "pendingPlanId" TEXT,
    "pendingPriceId" TEXT,
    "pendingEffectiveAt" TIMESTAMPTZ(3),
    "gracePeriodEndsAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPeriod" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "planCodeSnapshot" "BillingPlanCode" NOT NULL,
    "monthlyPriceCents" INTEGER NOT NULL,
    "includedStaffSeats" INTEGER NOT NULL,
    "extraStaffSeatPriceCents" INTEGER NOT NULL,
    "billableStaffSeats" INTEGER NOT NULL,
    "extraStaffSeats" INTEGER NOT NULL,
    "baseAmountCents" INTEGER NOT NULL,
    "extraSeatAmountCents" INTEGER NOT NULL,
    "prorationAmountCents" INTEGER NOT NULL DEFAULT 0,
    "totalAmountCents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "status" "BillingPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingInvoice" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "periodId" TEXT,
    "providerInvoiceId" VARCHAR(255),
    "status" "BillingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotalCents" INTEGER NOT NULL,
    "prorationCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "amountPaidCents" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "dueAt" TIMESTAMPTZ(3),
    "paidAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPaymentAttempt" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "providerPaymentId" VARCHAR(255),
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "BillingPaymentAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "failureCode" VARCHAR(128),
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingWebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "providerEventId" VARCHAR(255) NOT NULL,
    "eventType" VARCHAR(128) NOT NULL,
    "payload" JSONB NOT NULL,
    "signatureVerifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "BillingWebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingIdempotencyKey" (
    "id" TEXT NOT NULL,
    "scope" VARCHAR(128) NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "requestHash" VARCHAR(128) NOT NULL,
    "status" "BillingIdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "teamId" TEXT,
    "userId" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BillingIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingLedgerTransaction" (
    "id" TEXT NOT NULL,
    "teamId" TEXT,
    "subscriptionId" TEXT,
    "invoiceId" TEXT,
    "externalReference" VARCHAR(255) NOT NULL,
    "type" "BillingLedgerTransactionType" NOT NULL,
    "status" "BillingLedgerTransactionStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "totalDebitCents" INTEGER NOT NULL,
    "totalCreditCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "postedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingLedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingLedgerEntry" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "accountCode" VARCHAR(64) NOT NULL,
    "debitCents" INTEGER NOT NULL DEFAULT 0,
    "creditCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlan_code_key" ON "BillingPlan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlanPrice_providerPriceId_key" ON "BillingPlanPrice"("providerPriceId");

-- CreateIndex
CREATE INDEX "BillingPlanPrice_planId_effectiveFrom_idx" ON "BillingPlanPrice"("planId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPlanPrice_planId_effectiveFrom_key" ON "BillingPlanPrice"("planId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_teamId_key" ON "BillingSubscription"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_providerCustomerId_key" ON "BillingSubscription"("providerCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSubscription_providerSubscriptionId_key" ON "BillingSubscription"("providerSubscriptionId");

-- CreateIndex
CREATE INDEX "BillingSubscription_status_currentPeriodEnd_idx" ON "BillingSubscription"("status", "currentPeriodEnd");

-- CreateIndex
CREATE INDEX "BillingSubscription_status_gracePeriodEndsAt_idx" ON "BillingSubscription"("status", "gracePeriodEndsAt");

-- CreateIndex
CREATE INDEX "BillingPeriod_subscriptionId_startsAt_idx" ON "BillingPeriod"("subscriptionId", "startsAt");

-- CreateIndex
CREATE INDEX "BillingPeriod_status_endsAt_idx" ON "BillingPeriod"("status", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPeriod_subscriptionId_sequence_key" ON "BillingPeriod"("subscriptionId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPeriod_subscriptionId_startsAt_key" ON "BillingPeriod"("subscriptionId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_providerInvoiceId_key" ON "BillingInvoice"("providerInvoiceId");

-- CreateIndex
CREATE INDEX "BillingInvoice_subscriptionId_createdAt_idx" ON "BillingInvoice"("subscriptionId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingInvoice_status_dueAt_idx" ON "BillingInvoice"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPaymentAttempt_providerPaymentId_key" ON "BillingPaymentAttempt"("providerPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPaymentAttempt_idempotencyKey_key" ON "BillingPaymentAttempt"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BillingPaymentAttempt_status_createdAt_idx" ON "BillingPaymentAttempt"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPaymentAttempt_invoiceId_attemptNumber_key" ON "BillingPaymentAttempt"("invoiceId", "attemptNumber");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_status_receivedAt_idx" ON "BillingWebhookEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "BillingWebhookEvent_eventType_receivedAt_idx" ON "BillingWebhookEvent"("eventType", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingWebhookEvent_provider_providerEventId_key" ON "BillingWebhookEvent"("provider", "providerEventId");

-- CreateIndex
CREATE INDEX "BillingIdempotencyKey_teamId_createdAt_idx" ON "BillingIdempotencyKey"("teamId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingIdempotencyKey_expiresAt_idx" ON "BillingIdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingIdempotencyKey_scope_key_key" ON "BillingIdempotencyKey"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "BillingLedgerTransaction_externalReference_key" ON "BillingLedgerTransaction"("externalReference");

-- CreateIndex
CREATE INDEX "BillingLedgerTransaction_teamId_occurredAt_idx" ON "BillingLedgerTransaction"("teamId", "occurredAt");

-- CreateIndex
CREATE INDEX "BillingLedgerTransaction_subscriptionId_occurredAt_idx" ON "BillingLedgerTransaction"("subscriptionId", "occurredAt");

-- CreateIndex
CREATE INDEX "BillingLedgerTransaction_status_occurredAt_idx" ON "BillingLedgerTransaction"("status", "occurredAt");

-- CreateIndex
CREATE INDEX "BillingLedgerEntry_transactionId_idx" ON "BillingLedgerEntry"("transactionId");

-- CreateIndex
CREATE INDEX "BillingLedgerEntry_accountCode_createdAt_idx" ON "BillingLedgerEntry"("accountCode", "createdAt");

-- AddForeignKey
ALTER TABLE "BillingPlanPrice" ADD CONSTRAINT "BillingPlanPrice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_priceId_fkey" FOREIGN KEY ("priceId") REFERENCES "BillingPlanPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "BillingPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSubscription" ADD CONSTRAINT "BillingSubscription_pendingPriceId_fkey" FOREIGN KEY ("pendingPriceId") REFERENCES "BillingPlanPrice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPeriod" ADD CONSTRAINT "BillingPeriod_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BillingSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BillingSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingInvoice" ADD CONSTRAINT "BillingInvoice_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "BillingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPaymentAttempt" ADD CONSTRAINT "BillingPaymentAttempt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingIdempotencyKey" ADD CONSTRAINT "BillingIdempotencyKey_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingIdempotencyKey" ADD CONSTRAINT "BillingIdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLedgerTransaction" ADD CONSTRAINT "BillingLedgerTransaction_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLedgerTransaction" ADD CONSTRAINT "BillingLedgerTransaction_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "BillingSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLedgerTransaction" ADD CONSTRAINT "BillingLedgerTransaction_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLedgerEntry" ADD CONSTRAINT "BillingLedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "BillingLedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Billing invariants: all money is integer cents and billing periods are ordered.
ALTER TABLE "BillingPlanPrice"
  ADD CONSTRAINT "BillingPlanPrice_nonnegative_values_check"
  CHECK ("monthlyPriceCents" >= 0 AND "includedStaffSeats" >= 0 AND "extraStaffSeatPriceCents" >= 0),
  ADD CONSTRAINT "BillingPlanPrice_effective_range_check"
  CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

ALTER TABLE "BillingSubscription"
  ADD CONSTRAINT "BillingSubscription_period_range_check"
  CHECK ("currentPeriodEnd" IS NULL OR "currentPeriodStart" IS NULL OR "currentPeriodEnd" > "currentPeriodStart"),
  ADD CONSTRAINT "BillingSubscription_pending_change_pair_check"
  CHECK (("pendingPlanId" IS NULL AND "pendingPriceId" IS NULL AND "pendingEffectiveAt" IS NULL)
    OR ("pendingPlanId" IS NOT NULL AND "pendingPriceId" IS NOT NULL AND "pendingEffectiveAt" IS NOT NULL));

ALTER TABLE "BillingPeriod"
  ADD CONSTRAINT "BillingPeriod_range_check"
  CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "BillingPeriod_nonnegative_values_check"
  CHECK ("monthlyPriceCents" >= 0 AND "includedStaffSeats" >= 0 AND "extraStaffSeatPriceCents" >= 0
    AND "billableStaffSeats" >= 0 AND "extraStaffSeats" >= 0 AND "baseAmountCents" >= 0
    AND "extraSeatAmountCents" >= 0 AND "totalAmountCents" >= 0);

ALTER TABLE "BillingInvoice"
  ADD CONSTRAINT "BillingInvoice_nonnegative_values_check"
  CHECK ("subtotalCents" >= 0 AND "totalCents" >= 0 AND "amountPaidCents" >= 0);

ALTER TABLE "BillingPaymentAttempt"
  ADD CONSTRAINT "BillingPaymentAttempt_nonnegative_values_check"
  CHECK ("attemptNumber" > 0 AND "amountCents" >= 0);

ALTER TABLE "BillingLedgerTransaction"
  ADD CONSTRAINT "BillingLedgerTransaction_nonnegative_totals_check"
  CHECK ("totalDebitCents" >= 0 AND "totalCreditCents" >= 0);

ALTER TABLE "BillingLedgerEntry"
  ADD CONSTRAINT "BillingLedgerEntry_nonnegative_values_check"
  CHECK ("debitCents" >= 0 AND "creditCents" >= 0),
  ADD CONSTRAINT "BillingLedgerEntry_one_sided_check"
  CHECK (NOT ("debitCents" > 0 AND "creditCents" > 0));

-- Posted ledger rows are append-only. Draft transactions may be assembled and
-- balanced, but ordinary application users cannot alter or delete posted rows.
CREATE OR REPLACE FUNCTION "rota_guard_posted_ledger_transaction"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  entry_count BIGINT;
  debit_total BIGINT;
  credit_total BIGINT;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM 1
      FROM public."BillingLedgerTransaction"
      WHERE "status" = 'POSTED'
      ORDER BY "id"
      FOR UPDATE;

    IF EXISTS (SELECT 1 FROM public."BillingLedgerTransaction" WHERE "status" = 'POSTED') THEN
      RAISE EXCEPTION 'Posted ledger transactions are append-only';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM 1
      FROM public."BillingLedgerTransaction"
      WHERE "id" = OLD."id"
      FOR UPDATE;

    IF OLD."status" = 'POSTED' THEN
      RAISE EXCEPTION 'Posted ledger transactions are append-only';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    PERFORM 1
      FROM public."BillingLedgerTransaction"
      WHERE "id" = NEW."id"
      FOR UPDATE;

    IF OLD."status" = 'POSTED' THEN
      RAISE EXCEPTION 'Posted ledger transactions are append-only';
    END IF;
  END IF;

  IF NEW."status" = 'POSTED' THEN
    IF NEW."postedAt" IS NULL THEN
      RAISE EXCEPTION 'Posted ledger transactions require postedAt';
    END IF;

    SELECT COUNT(*), COALESCE(SUM("debitCents"), 0), COALESCE(SUM("creditCents"), 0)
      INTO entry_count, debit_total, credit_total
      FROM public."BillingLedgerEntry"
      WHERE "transactionId" = NEW."id";

    IF entry_count = 0 OR debit_total <> NEW."totalDebitCents" OR credit_total <> NEW."totalCreditCents"
      OR debit_total <> credit_total THEN
      RAISE EXCEPTION 'Posted ledger transactions must have balanced matching entries';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "rota_guard_posted_ledger_entry"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  transaction_id TEXT;
  original_status public."BillingLedgerTransactionStatus";
  proposed_status public."BillingLedgerTransactionStatus";
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    PERFORM 1
      FROM public."BillingLedgerTransaction"
      ORDER BY "id"
      FOR UPDATE;

    IF EXISTS (
      SELECT 1
      FROM public."BillingLedgerEntry" entry
      INNER JOIN public."BillingLedgerTransaction" transaction_record
        ON transaction_record."id" = entry."transactionId"
      WHERE transaction_record."status" = 'POSTED'
    ) THEN
      RAISE EXCEPTION 'Entries for posted ledger transactions are append-only';
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    FOR transaction_id IN
      SELECT "id"
      FROM public."BillingLedgerTransaction"
      WHERE "id" = NEW."transactionId"
      ORDER BY "id"
      FOR UPDATE
    LOOP
      NULL;
    END LOOP;

    SELECT "status" INTO proposed_status
      FROM public."BillingLedgerTransaction"
      WHERE "id" = NEW."transactionId";

    IF proposed_status = 'POSTED' THEN
      RAISE EXCEPTION 'Entries for posted ledger transactions are append-only';
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    FOR transaction_id IN
      SELECT "id"
      FROM public."BillingLedgerTransaction"
      WHERE "id" = OLD."transactionId"
      ORDER BY "id"
      FOR UPDATE
    LOOP
      NULL;
    END LOOP;

    SELECT "status" INTO original_status
      FROM public."BillingLedgerTransaction"
      WHERE "id" = OLD."transactionId";

    IF original_status = 'POSTED' THEN
      RAISE EXCEPTION 'Entries for posted ledger transactions are append-only';
    END IF;

    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Lock both parents in one deterministic order before reading either status.
    FOR transaction_id IN
      SELECT DISTINCT affected_id
      FROM unnest(ARRAY[OLD."transactionId", NEW."transactionId"]) AS affected(affected_id)
      ORDER BY affected_id
    LOOP
      PERFORM 1
        FROM public."BillingLedgerTransaction"
        WHERE "id" = transaction_id
        FOR UPDATE;
    END LOOP;

    SELECT "status" INTO original_status
      FROM public."BillingLedgerTransaction"
      WHERE "id" = OLD."transactionId";
    SELECT "status" INTO proposed_status
      FROM public."BillingLedgerTransaction"
      WHERE "id" = NEW."transactionId";

    IF original_status = 'POSTED' OR proposed_status = 'POSTED' THEN
      RAISE EXCEPTION 'Entries for posted ledger transactions are append-only';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Unsupported ledger entry trigger operation: %', TG_OP;
END;
$$;

CREATE TRIGGER "BillingLedgerTransaction_posted_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "BillingLedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION "rota_guard_posted_ledger_transaction"();

CREATE TRIGGER "BillingLedgerTransaction_posted_truncate_guard"
  BEFORE TRUNCATE ON "BillingLedgerTransaction"
  FOR EACH STATEMENT EXECUTE FUNCTION "rota_guard_posted_ledger_transaction"();

CREATE TRIGGER "BillingLedgerEntry_posted_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "BillingLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "rota_guard_posted_ledger_entry"();

CREATE TRIGGER "BillingLedgerEntry_posted_truncate_guard"
  BEFORE TRUNCATE ON "BillingLedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "rota_guard_posted_ledger_entry"();
