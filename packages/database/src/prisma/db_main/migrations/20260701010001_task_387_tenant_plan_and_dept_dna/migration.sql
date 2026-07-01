-- TASK-387 (#3 + #7) — Tenant.plan + Department.dnaWritingStylePromptId.
-- Fully additive: creates a new enum type, adds a nullable plan column (existing
-- rows read NULL = "unspecified"), and adds a nullable loose prompt-ref column to
-- Department (mirrors the existing preSummary/newPatient/revisit prompt refs).
-- No DROP/DELETE/TRUNCATE; no changes to existing columns.

-- CreateEnum
CREATE TYPE "core"."TenantPlan" AS ENUM ('ENTERPRISE', 'PRO', 'TRIAL', 'STARTER');

-- AlterTable
ALTER TABLE "core"."Tenant" ADD COLUMN     "plan" "core"."TenantPlan";

-- AlterTable
ALTER TABLE "core"."Department" ADD COLUMN     "dnaWritingStylePromptId" TEXT;
