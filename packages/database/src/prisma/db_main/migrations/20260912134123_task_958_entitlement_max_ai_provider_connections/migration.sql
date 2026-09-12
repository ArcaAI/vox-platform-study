-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "maxAiProviderConnections" INTEGER;

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "maxAiProviderConnections" INTEGER;
