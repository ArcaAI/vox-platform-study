-- AlterEnum
ALTER TYPE "core"."UsageMeterMetric" ADD VALUE 'WORKFLOW_INVOCATIONS';

-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "maxWorkflowDefinitions" INTEGER,
ADD COLUMN     "monthlyWorkflowInvocations" INTEGER;

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "maxWorkflowDefinitions" INTEGER,
ADD COLUMN     "monthlyWorkflowInvocations" INTEGER;

-- NOTE (TASK-722): `prisma migrate dev --create-only` also proposed a
-- `RenameIndex` for "TenantNlpTaskInstructions_tenant_task_unique" here.
-- That is PRE-EXISTING drift from TASK-729 (its `@@unique(..., name: "...")`
-- uses `name:` where rule 02 requires `map:` for the DB index name — the
-- exact TASK-648 trap), unrelated to this ticket's entitlement columns.
-- Deliberately NOT bundled into this migration — see this ticket's README §7
-- and the follow-up task flagged for TASK-729's owner.
