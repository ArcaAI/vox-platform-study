-- Schema follow-ups (items #4–#7). All changes are additive
-- and back-compatible with the usage-ledger + billing plane created in
-- 20260806000000_task_615_usage_ledger_and_billing:
--   #5 TenantUsageMeter.usedCount Int32 -> BigInt (token/character meters overflow Int32).
--   #4 operation dimension on both rollups (LLM_TOKENS meter over-counted guardrail+harness).
--   #7 cacheTtl price dimension on AiPriceBook (per-TTL Anthropic cache-write rates).
--   #6 TenantPlanHistory table (true mid-period plan-fee proration; append-only).
--
-- The rollup ADD COLUMN uses DEFAULT '' so existing aggregate rows keep a stable,
-- collision-free dimension tuple (empty-string sentinel, same discipline as
-- `model`); the unique index is dropped and recreated to include `operation`.

-- DropIndex
DROP INDEX "core"."AiUsageRollupHourly_tenantId_bucketStart_capability_provide_key";

-- DropIndex
DROP INDEX "core"."AiUsageRollupDaily_tenantId_bucketStart_capability_provider_key";

-- AlterTable
ALTER TABLE "core"."TenantUsageMeter" ALTER COLUMN "usedCount" SET DATA TYPE BIGINT;

-- AlterTable
ALTER TABLE "core"."AiPriceBook" ADD COLUMN     "cacheTtl" TEXT;

-- AlterTable
ALTER TABLE "core"."AiUsageRollupHourly" ADD COLUMN     "operation" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "core"."AiUsageRollupDaily" ADD COLUMN     "operation" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "core"."TenantPlanHistory" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plan" "core"."TenantPlan" NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "previousPlan" "core"."TenantPlan",
    "changeReason" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantPlanHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantPlanHistory_tenantId_idx" ON "core"."TenantPlanHistory"("tenantId");

-- CreateIndex
CREATE INDEX "TenantPlanHistory_tenant_effectiveFrom_idx" ON "core"."TenantPlanHistory"("tenantId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageRollupHourly_tenantId_bucketStart_capability_operati_key" ON "core"."AiUsageRollupHourly"("tenantId", "bucketStart", "capability", "operation", "provider", "model", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageRollupDaily_tenantId_bucketStart_capability_operatio_key" ON "core"."AiUsageRollupDaily"("tenantId", "bucketStart", "capability", "operation", "provider", "model", "unit");
