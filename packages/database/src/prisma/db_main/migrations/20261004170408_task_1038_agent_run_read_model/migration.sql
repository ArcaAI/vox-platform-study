-- CreateEnum
CREATE TYPE "core"."WorkflowRunKind" AS ENUM ('WORKFLOW', 'AGENT');

-- AlterTable
ALTER TABLE "core"."WorkflowRun" ADD COLUMN     "agentSlug" TEXT,
ADD COLUMN     "agentVersionId" TEXT,
ADD COLUMN     "agentVersionNumber" INTEGER,
ADD COLUMN     "kind" "core"."WorkflowRunKind" NOT NULL DEFAULT 'WORKFLOW',
ALTER COLUMN "workflowVersionId" DROP NOT NULL,
ALTER COLUMN "workflowSlug" DROP NOT NULL,
ALTER COLUMN "workflowVersionNumber" DROP NOT NULL,
ALTER COLUMN "definitionName" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_kind_startedAt_idx" ON "core"."WorkflowRun"("tenantId", "kind", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_agentSlug_idx" ON "core"."WorkflowRun"("tenantId", "agentSlug");

-- CHECK constraint (Prisma does not model CHECKs) — appended by hand from
-- docs/implementation/TASK-1038-Run-Integrity-And-Delivery-Plane/sql/task_1038_agent_run_read_model.sql
ALTER TABLE "core"."WorkflowRun" ADD CONSTRAINT "WorkflowRun_kind_identity_check" CHECK (
  ("kind" = 'WORKFLOW'
     AND "workflowVersionId" IS NOT NULL AND "workflowSlug" IS NOT NULL
     AND "workflowVersionNumber" IS NOT NULL AND "definitionName" IS NOT NULL
     AND "agentSlug" IS NULL AND "agentVersionId" IS NULL AND "agentVersionNumber" IS NULL)
  OR
  ("kind" = 'AGENT'
     AND "agentSlug" IS NOT NULL AND "agentVersionId" IS NOT NULL AND "agentVersionNumber" IS NOT NULL
     AND "workflowVersionId" IS NULL AND "workflowSlug" IS NULL
     AND "workflowVersionNumber" IS NULL AND "definitionName" IS NULL)
);
