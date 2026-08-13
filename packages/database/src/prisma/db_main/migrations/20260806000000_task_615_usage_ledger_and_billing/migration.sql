-- AI Usage Metering, Consumption Monitoring & Tenant Billing.
--
-- STRICTLY ADDITIVE. Nine new enum types, thirteen new enum VALUES on two
-- existing types, eleven new nullable columns on the two entitlement tables, and
-- eight new tables. No column is dropped, no column changes type, no row is
-- touched, and every new column is NULLABLE or DEFAULTed — so this migration is
-- a behavioural no-op until the WS-B services start writing.
--
-- The eight tables split into two planes:
--   METERING (usage-ledger.prisma) — AiUsageEvent (append-only ledger),
--     AiUsageOutbox (transactional outbox), AiPriceBook (effective-dated,
--     supersede-only rate card, COST + SELL planes), AiUsageRollupHourly /
--     AiUsageRollupDaily (Postgres-first pre-aggregates).
--   BILLING (billing.prisma) — BillingInvoice, BillingInvoiceLine,
--     BillingAdjustment (credit memos; the only way to correct a FINALIZED
--     period).
--
-- Money is INTEGER MICROS (BIGINT) throughout; quantities are DECIMAL. No
-- DOUBLE PRECISION column exists anywhere in this migration — floats are never
-- used for money or for values that get multiplied by prices.
--
-- Enum ADD VALUEs use IF NOT EXISTS: dev/test Postgres is `db push`-managed, so
-- the type may already carry the value when this migration is first applied
-- there (same treatment as the enum migrations).

-- ---------------------------------------------------------------------------
-- 1. New enum types (metering + billing vocabulary)
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "core"."AiCapability" AS ENUM ('STT', 'LLM', 'NLP', 'TTS', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "core"."AiUsageUnit" AS ENUM ('INPUT_TOKEN', 'OUTPUT_TOKEN', 'CACHE_READ_TOKEN', 'CACHE_WRITE_TOKEN', 'REASONING_TOKEN', 'AUDIO_SECOND', 'SESSION_SECOND', 'CHARACTER', 'TEXT_UNIT', 'REQUEST', 'GPU_SECOND');

-- CreateEnum
CREATE TYPE "core"."AiDeploymentKind" AS ENUM ('SELF_HOSTED', 'CLOUD', 'BYOK');

-- CreateEnum
CREATE TYPE "core"."AiCostBasis" AS ENUM ('INTERNAL', 'BYOK_NOTIONAL');

-- CreateEnum
CREATE TYPE "core"."AiPriceBookPlane" AS ENUM ('COST', 'SELL');

-- CreateEnum
CREATE TYPE "core"."AiPriceRowKind" AS ENUM ('USAGE_UNIT', 'PLAN_FEE');

-- CreateEnum
CREATE TYPE "core"."AiUsageOutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED');

-- CreateEnum
CREATE TYPE "core"."BillingInvoiceStatus" AS ENUM ('DRAFT', 'FINALIZED', 'VOID');

-- CreateEnum
CREATE TYPE "core"."BillingLineKind" AS ENUM ('PLAN_FEE', 'OVERAGE', 'ADJUSTMENT');

-- ---------------------------------------------------------------------------
-- 2. Enum value additions on existing types
--
-- ResourceType: ONLY the three admin-managed models of the new plane. The
-- append-only ledger / outbox / rollups and invoice LINES deliberately get no
-- value — they emit no sys-event (the AgentTrajectoryStep precedent), and the
-- domain-layer `ResourceType` TS enum is kept in lock-step by
-- resourceType.enum-parity.test.ts.
--
-- Both types are only ever READ by rows written after this migration, so no
-- statement below uses a value added in this same transaction (the PG
-- restriction on ALTER TYPE ... ADD VALUE inside a transaction block).
-- ---------------------------------------------------------------------------

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'AiPriceBook';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'BillingInvoice';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'BillingAdjustment';

-- AlterEnum
-- The six ledger-derived unit meters (D5). The three pre-existing values
-- (CONSULTATIONS / TRANSCRIPTION_MINUTES / SUMMARIES) are business-object
-- meters and are unchanged.
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE IF NOT EXISTS 'STT_SESSION_SECONDS';
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE IF NOT EXISTS 'LLM_TOKENS';
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE IF NOT EXISTS 'TTS_CHARACTERS';
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE IF NOT EXISTS 'NLP_TEXT_UNITS';
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE IF NOT EXISTS 'GUARDRAIL_CALLS';
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE IF NOT EXISTS 'EMBEDDING_TOKENS';

-- ---------------------------------------------------------------------------
-- 3. Per-capability included allowances on the entitlement tables (D11)
--
-- All NULLABLE, and NULL already means "unlimited" for every other meter column
-- on these tables — so existing plans and tenant overrides keep behaving exactly
-- as they do today until an admin sets a ceiling. BIGINT because enterprise
-- token/character counts exceed INT4.
--
-- No `monthlyGuardrailCalls` column: guardrail is metered but NEVER
-- quota-blocked (D6/D16), so a ceiling for it would be a control nothing reads.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "monthlyEmbeddingTokens" BIGINT,
ADD COLUMN     "monthlyLlmTokens" BIGINT,
ADD COLUMN     "monthlyNlpTextUnits" BIGINT,
ADD COLUMN     "monthlySttSessionSeconds" BIGINT,
ADD COLUMN     "monthlyTtsCharacters" BIGINT;

-- AlterTable
-- `monthlySpendLimitMicros` is TENANT-SET and exists only here (not on
-- PlanEntitlement): allowances are what the PLAN includes, the spend limit is
-- what the TENANT is willing to spend beyond them. Exhausting it yields 402.
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "monthlyEmbeddingTokens" BIGINT,
ADD COLUMN     "monthlyLlmTokens" BIGINT,
ADD COLUMN     "monthlyNlpTextUnits" BIGINT,
ADD COLUMN     "monthlySpendLimitMicros" BIGINT,
ADD COLUMN     "monthlySttSessionSeconds" BIGINT,
ADD COLUMN     "monthlyTtsCharacters" BIGINT;

-- ---------------------------------------------------------------------------
-- 4. Billing plane
-- ---------------------------------------------------------------------------

-- CreateTable
-- The one OCC-written model of this ticket: `_version` guards the draft edits
-- and the FINALIZE state transition so two concurrent finalizes cannot both
-- succeed on a money document.
CREATE TABLE "core"."BillingInvoice" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "core"."BillingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotalMicros" BIGINT NOT NULL DEFAULT 0,
    "totalMicros" BIGINT NOT NULL DEFAULT 0,
    "finalizedAt" TIMESTAMP(3),
    "finalizedBy" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Lines record the FULL derivation (usage, allowance, overage, rate, amount) so
-- a disputed charge can be answered from the invoice alone.
CREATE TABLE "core"."BillingInvoiceLine" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "core"."BillingLineKind" NOT NULL,
    "capability" "core"."AiCapability",
    "unit" "core"."AiUsageUnit",
    "quantity" DECIMAL(38,6),
    "includedAllowance" DECIMAL(38,6),
    "overageQuantity" DECIMAL(38,6),
    "unitPriceMicros" BIGINT,
    "amountMicros" BIGINT NOT NULL,
    "description" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Credit memo against a FINALIZED (immutable) invoice — APPEND-ONLY, hence no
-- `resourceStatus` columns (listed in MODELS_WITHOUT_SOFT_DELETE). Negative
-- `amountMicros` = credit.
CREATE TABLE "core"."BillingAdjustment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAdjustment_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 5. Metering plane
-- ---------------------------------------------------------------------------

-- CreateTable
-- The append-only usage ledger. One row per (request, unit); `idempotencyKey` is
-- UNIQUE (index below) and is what makes a retried emission a no-op instead of a
-- double charge. No `resourceStatus` columns — append-only under hard retention.
CREATE TABLE "core"."AiUsageEvent" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capability" "core"."AiCapability" NOT NULL,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "deployment" "core"."AiDeploymentKind" NOT NULL,
    "unit" "core"."AiUsageUnit" NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "consultationId" TEXT,
    "doctorId" TEXT,
    "departmentId" TEXT,
    "requestId" TEXT,
    "sessionId" TEXT,
    "unitPriceMicros" BIGINT,
    "priceBookVersion" TEXT,
    "costMicros" BIGINT,
    "costBasis" "core"."AiCostBasis" NOT NULL DEFAULT 'INTERNAL',
    "attributesJson" JSONB,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Transactional outbox: written INSIDE the business transaction that produced
-- the usage, drained asynchronously into AiUsageEvent.
CREATE TABLE "core"."AiUsageOutbox" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "core"."AiUsageOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Effective-dated, supersede-only rate card. SYSTEM-tenant rows are the platform
-- card (SYSTEM_SHARED_READ_MODELS: reads widen to [caller, SYSTEM], writes do
-- not). The one admin-managed model of this plane — keeps soft delete.
CREATE TABLE "core"."AiPriceBook" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plane" "core"."AiPriceBookPlane" NOT NULL,
    "rowKind" "core"."AiPriceRowKind" NOT NULL DEFAULT 'USAGE_UNIT',
    "planTier" "core"."TenantPlan",
    "capability" "core"."AiCapability",
    "provider" TEXT,
    "model" TEXT,
    "unit" "core"."AiUsageUnit",
    "contextBand" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "unitPriceMicros" BIGINT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "bookVersion" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPriceBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Hourly pre-aggregate. `model` is NOT NULL with an EMPTY-STRING SENTINEL
-- default: Postgres treats each NULL as DISTINCT, so a nullable column in the
-- unique dimension tuple below would make the maintenance upsert silently
-- non-idempotent and double-count model-less capabilities. Same fix as
-- AgentTrajectoryStep."runId".
CREATE TABLE "core"."AiUsageRollupHourly" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "capability" "core"."AiCapability" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "unit" "core"."AiUsageUnit" NOT NULL,
    "quantitySum" DECIMAL(38,6) NOT NULL,
    "costMicrosSum" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageRollupHourly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Daily pre-aggregate — the grain invoice computation and month-to-date
-- consumption screens read. Same NULL-free dimension tuple as the hourly rollup.
CREATE TABLE "core"."AiUsageRollupDaily" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "capability" "core"."AiCapability" NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "unit" "core"."AiUsageUnit" NOT NULL,
    "quantitySum" DECIMAL(38,6) NOT NULL,
    "costMicrosSum" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageRollupDaily_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 6. Indexes
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE INDEX "BillingInvoice_tenantId_idx" ON "core"."BillingInvoice"("tenantId");

-- CreateIndex
CREATE INDEX "BillingInvoice_tenant_status_idx" ON "core"."BillingInvoice"("tenantId", "status");

-- CreateIndex
-- One invoice per (tenant, period): the guard against a re-run of the monthly
-- draft job silently issuing a second invoice for the same month.
CREATE UNIQUE INDEX "BillingInvoice_tenantId_periodStart_key" ON "core"."BillingInvoice"("tenantId", "periodStart");

-- CreateIndex
CREATE INDEX "BillingInvoiceLine_tenant_invoice_idx" ON "core"."BillingInvoiceLine"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "BillingInvoiceLine_invoiceId_idx" ON "core"."BillingInvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingAdjustment_tenant_invoice_idx" ON "core"."BillingAdjustment"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "BillingAdjustment_invoiceId_idx" ON "core"."BillingAdjustment"("invoiceId");

-- CreateIndex
-- THE anti-double-billing constraint.
CREATE UNIQUE INDEX "AiUsageEvent_idempotencyKey_key" ON "core"."AiUsageEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenant_occurredAt_idx" ON "core"."AiUsageEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenant_capability_occurredAt_idx" ON "core"."AiUsageEvent"("tenantId", "capability", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_requestId_idx" ON "core"."AiUsageEvent"("requestId");

-- CreateIndex
-- The drainer's claim query (all tenants, oldest available first).
CREATE INDEX "AiUsageOutbox_status_availableAt_idx" ON "core"."AiUsageOutbox"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AiUsageOutbox_tenantId_idx" ON "core"."AiUsageOutbox"("tenantId");

-- CreateIndex
-- The rater's hot path: resolve a price effective at a point in time.
CREATE INDEX "AiPriceBook_resolution_idx" ON "core"."AiPriceBook"("tenantId", "plane", "capability", "provider", "model", "unit", "effectiveFrom");

-- CreateIndex
-- The invoice engine's path: plan fees and per-tier overage rates.
CREATE INDEX "AiPriceBook_plan_resolution_idx" ON "core"."AiPriceBook"("tenantId", "plane", "rowKind", "planTier", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AiPriceBook_tenantId_idx" ON "core"."AiPriceBook"("tenantId");

-- CreateIndex
CREATE INDEX "AiUsageRollupHourly_tenant_bucketStart_idx" ON "core"."AiUsageRollupHourly"("tenantId", "bucketStart");

-- CreateIndex
-- The rollup UPSERT key — see the empty-string sentinel note on the table.
CREATE UNIQUE INDEX "AiUsageRollupHourly_tenantId_bucketStart_capability_provide_key" ON "core"."AiUsageRollupHourly"("tenantId", "bucketStart", "capability", "provider", "model", "unit");

-- CreateIndex
CREATE INDEX "AiUsageRollupDaily_tenant_bucketStart_idx" ON "core"."AiUsageRollupDaily"("tenantId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageRollupDaily_tenantId_bucketStart_capability_provider_key" ON "core"."AiUsageRollupDaily"("tenantId", "bucketStart", "capability", "provider", "model", "unit");

-- ---------------------------------------------------------------------------
-- 7. Foreign keys
--
-- ON DELETE RESTRICT: an invoice with lines or adjustments cannot be hard
-- deleted. Invoices are soft-deleted (withdrawn) rather than removed, and
-- adjustments against a finalized period must outlive any attempt to tidy up.
-- ---------------------------------------------------------------------------

-- AddForeignKey
ALTER TABLE "core"."BillingInvoiceLine" ADD CONSTRAINT "BillingInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "core"."BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "core"."BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
