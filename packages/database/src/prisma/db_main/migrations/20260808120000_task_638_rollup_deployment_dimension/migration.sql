-- TASK-638 — deployment dimension on the usage rollups.
--
-- Billing consumes a capability's pooled allowance SELF_HOSTED-first so that
-- platform-funded managed usage spills into premium-rated overage, and so that
-- BYOK never pays a premium meant to recover platform COGS the platform is not
-- bearing. `provider` alone cannot express that: the same `azure-speech` slug
-- is CLOUD on a platform key and BYOK on a tenant key.
--
-- Additive. Existing rows default to SELF_HOSTED, which is the conservative
-- backfill: pre-existing usage keeps consuming the allowance first and is never
-- retroactively re-rated at a managed premium.
-- DropIndex
DROP INDEX "core"."AiUsageRollupHourly_tenantId_bucketStart_capability_operati_key";

-- DropIndex
DROP INDEX "core"."AiUsageRollupDaily_tenantId_bucketStart_capability_operatio_key";

-- AlterTable
ALTER TABLE "core"."AiUsageRollupHourly" ADD COLUMN     "deployment" "core"."AiDeploymentKind" NOT NULL DEFAULT 'SELF_HOSTED';

-- AlterTable
ALTER TABLE "core"."AiUsageRollupDaily" ADD COLUMN     "deployment" "core"."AiDeploymentKind" NOT NULL DEFAULT 'SELF_HOSTED';

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageRollupHourly_tenantId_bucketStart_capability_operati_key" ON "core"."AiUsageRollupHourly"("tenantId", "bucketStart", "capability", "operation", "provider", "deployment", "model", "unit");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageRollupDaily_tenantId_bucketStart_capability_operatio_key" ON "core"."AiUsageRollupDaily"("tenantId", "bucketStart", "capability", "operation", "provider", "deployment", "model", "unit");

