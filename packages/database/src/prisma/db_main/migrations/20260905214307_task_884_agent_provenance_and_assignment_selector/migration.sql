-- TASK-884 — agent provenance columns and the tag selector on assignments. Authored from
-- `prisma migrate diff --script` on a replayed shadow (the interactive create-only refuses a
-- unique-index warning in a non-interactive shell). Every existing assignment row gets
-- selectorKey = '' — the unqualified assignment the cascade already served — so no data step.
-- DropIndex
DROP INDEX "core"."AgentAssignment_scope_task_unique";

-- AlterTable
ALTER TABLE "core"."Agent" ADD COLUMN     "sourceAgentId" TEXT,
ADD COLUMN     "sourceSlug" TEXT,
ADD COLUMN     "sourceTenantId" TEXT,
ADD COLUMN     "sourceVersionNumber" INTEGER;

-- AlterTable
ALTER TABLE "core"."AgentAssignment" ADD COLUMN     "selectorKey" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "core"."AgentAssignmentChange" ADD COLUMN     "selectorKey" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "AgentAssignment_scope_task_selector_unique" ON "core"."AgentAssignment"("tenantId", "scope", "scopeId", "task", "selectorKey");
