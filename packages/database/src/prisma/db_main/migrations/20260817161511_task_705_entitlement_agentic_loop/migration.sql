-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "featureAgenticLoop" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "featureAgenticLoop" BOOLEAN;

-- Backfill: the column default is `true`, so an ALREADY-SEEDED database
-- would silently grant STARTER the harness agentic loop. Seed `15-entitlements.ts`
-- cannot correct it — its plan-matrix upsert is deliberately create-only
-- (`update: {}`) so a re-seed never clobbers admin-tuned values. Align the STARTER
-- row with the seeded packaging (STARTER out, TRIAL/PRO/ENTERPRISE in) exactly once.
UPDATE "core"."PlanEntitlement" SET "featureAgenticLoop" = false WHERE "plan" = 'STARTER';
