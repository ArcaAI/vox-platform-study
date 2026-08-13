-- BASELINE — Entitlement plane (UsageMeterMetric + PlanEntitlement /
-- TenantEntitlement / TenantUsageMeter).
--
-- These four objects exist in `entitlement.prisma` and in the db-push-managed
-- dev/test databases, but NO committed migration ever created them — they were
-- materialised by `prisma db push` only. A database built purely from the
-- migration history (a fresh `prisma migrate deploy`, e.g. the k3s `db-migrate`
-- PreSync Job, or CI) therefore lacked them, and the follow-on migration
-- `20260806000000_task_615_usage_ledger_and_billing` — which does
-- `ALTER TABLE "core"."PlanEntitlement" ADD COLUMN ...` and
-- `ALTER TYPE "core"."UsageMeterMetric" ADD VALUE ...` — failed there with
-- `type "core.UsageMeterMetric" does not exist`.
--
-- This migration is timestamped BEFORE `20260806000000` so it orders ahead of
-- that migration and supplies the objects it extends.
--
-- IMPORTANT — this creates the PRE- shape:
--   * the enum carries ONLY its three original values (CONSULTATIONS,
--     TRANSCRIPTION_MINUTES, SUMMARIES); the six ledger-derived meters are added
-- by the `ALTER TYPE ... ADD VALUE` block in the migration.
--   * PlanEntitlement / TenantEntitlement OMIT the per-capability allowance
--     BIGINT columns (and TenantEntitlement's `monthlySpendLimitMicros`); those
-- are added by the `ALTER TABLE ... ADD COLUMN` blocks in the
--     migration.
-- Replaying [this] -> therefore reproduces the current schema
-- exactly (verified: the resulting `prisma migrate diff` against the schema is
-- empty).
--
-- Written idempotently (a DO-guarded `CREATE TYPE`, `CREATE TABLE IF NOT EXISTS`,
-- `CREATE ... INDEX IF NOT EXISTS`) so it is a strict no-op on the db-push
-- databases that already carry these objects (there in their full, post-615
-- shape) — nothing is created, altered or dropped there.

-- ---------------------------------------------------------------------------
-- 1. UsageMeterMetric enum — original three business-object meters only.
-- ---------------------------------------------------------------------------

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'UsageMeterMetric' AND n.nspname = 'core'
  ) THEN
    CREATE TYPE "core"."UsageMeterMetric" AS ENUM ('CONSULTATIONS', 'TRANSCRIPTION_MINUTES', 'SUMMARIES');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. PlanEntitlement — platform-wide per-plan default matrix (no tenantId).
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."PlanEntitlement" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "plan" "core"."TenantPlan" NOT NULL,
    "maxUsers" INTEGER,
    "maxDepartments" INTEGER,
    "maxPromptTemplates" INTEGER,
    "maxAsrPipelines" INTEGER,
    "maxApiKeys" INTEGER,
    "storageQuotaBytes" BIGINT,
    "maxConcurrentSessions" INTEGER,
    "monthlyConsultations" INTEGER,
    "monthlyTranscriptionMinutes" INTEGER,
    "monthlySummaries" INTEGER,
    "featureDnaReports" BOOLEAN NOT NULL DEFAULT false,
    "featureVoiceEnrollment" BOOLEAN NOT NULL DEFAULT false,
    "featureMonitoringAccess" BOOLEAN NOT NULL DEFAULT false,
    "modelTier" TEXT NOT NULL DEFAULT 'full',
    "rateLimitTier" TEXT NOT NULL DEFAULT 'default',
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanEntitlement_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3. TenantEntitlement — per-tenant override (one row per tenant).
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."TenantEntitlement" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "maxUsers" INTEGER,
    "maxDepartments" INTEGER,
    "maxPromptTemplates" INTEGER,
    "maxAsrPipelines" INTEGER,
    "maxApiKeys" INTEGER,
    "storageQuotaBytes" BIGINT,
    "maxConcurrentSessions" INTEGER,
    "monthlyConsultations" INTEGER,
    "monthlyTranscriptionMinutes" INTEGER,
    "monthlySummaries" INTEGER,
    "featureDnaReports" BOOLEAN,
    "featureVoiceEnrollment" BOOLEAN,
    "featureMonitoringAccess" BOOLEAN,
    "modelTier" TEXT,
    "rateLimitTier" TEXT,
    "rateLimitPerMinute" INTEGER,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantEntitlement_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 4. TenantUsageMeter — rolling-monthly windowed consumption counter.
-- (Untouched by; created here in full.)
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."TenantUsageMeter" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metric" "core"."UsageMeterMetric" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "reconciledAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantUsageMeter_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 5. Indexes
-- ---------------------------------------------------------------------------

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PlanEntitlement_plan_key" ON "core"."PlanEntitlement"("plan");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TenantEntitlement_tenantId_key" ON "core"."TenantEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TenantEntitlement_tenantId_idx" ON "core"."TenantEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TenantUsageMeter_tenantId_idx" ON "core"."TenantUsageMeter"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TenantUsageMeter_tenantId_metric_periodStart_key" ON "core"."TenantUsageMeter"("tenantId", "metric", "periodStart");
