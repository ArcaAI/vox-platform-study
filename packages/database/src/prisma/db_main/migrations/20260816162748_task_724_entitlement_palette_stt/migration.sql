-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "featurePaletteStt" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "featurePaletteStt" BOOLEAN;
