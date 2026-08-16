-- Workflow Run: the read model for runs/observability (TASK-723), scoped per
-- D6's "CQRS-lite ... read models for runs/observability" (design.md).
--
-- Adds a single new table + enum. One row per workflow-substrate run,
-- correlated to AgentTrajectoryStep by `sessionId` (see the header comment in
-- workflow-run.prisma and
-- docs/implementation/TASK-723-Runs-Observability/contracts/run-read-model.contract.md).
--
-- Additive only: no existing table or column is touched. `WorkflowRun` emits
-- no sys-events (telemetry exemption, same posture as AgentTrajectoryStep), so
-- deliberately NO `ALTER TYPE ... ResourceType ADD VALUE` here — rule 03 step 4
-- conditions that entry on sys-event emission, which this model does not do.
--
-- NOTE (rule 02): this migration is AUTHORED by hand against the shadow-DB
-- recipe but has NOT been applied/proven in this session — local infra
-- (Postgres) is down. The shadow-DB `prisma migrate diff` empty-diff proof
-- required by the Definition of Done is UN-RUN; see README §7.

-- CreateEnum
CREATE TYPE "core"."WorkflowRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "core"."WorkflowRun" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "workflowSlug" TEXT NOT NULL,
    "workflowVersionNumber" INTEGER NOT NULL,
    "definitionName" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "trigger" TEXT NOT NULL,
    "status" "core"."WorkflowRunStatus" NOT NULL DEFAULT 'RUNNING',
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "nodeCount" INTEGER,
    "failedNodeCount" INTEGER NOT NULL DEFAULT 0,
    "degradedNodeCount" INTEGER NOT NULL DEFAULT 0,
    "firstErrorCode" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_session_run_key" ON "core"."WorkflowRun"("tenantId", "sessionId", "runId");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_startedAt_idx" ON "core"."WorkflowRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_version_idx" ON "core"."WorkflowRun"("tenantId", "workflowVersionId");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_slug_idx" ON "core"."WorkflowRun"("tenantId", "workflowSlug");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_status_idx" ON "core"."WorkflowRun"("tenantId", "status");
