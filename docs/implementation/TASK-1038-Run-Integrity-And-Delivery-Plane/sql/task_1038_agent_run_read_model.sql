-- TASK-1038 OD-26 (lane B6a) — the run read model holds AGENT runs.
--
-- Status: the SQL lane B6a EXPECTS the migration to contain. NOT a migration and deliberately NOT
-- under packages/database/src/prisma/db_main/migrations/ (rule 02: Prisma applies every folder
-- there). The orchestrator authors the real migration on a shadow DB (rule 02 recipe):
--   pnpm --filter @arcaai/database db:migrate:create -n task_1038_agent_run_read_model
-- then appends the CHECK constraint below by hand (Prisma does not model CHECKs, so
-- `migrate diff` neither emits nor drifts on it) and proves `migrate diff` is empty afterwards.
--
-- Supersedes B2's proposal (agent-run-read-model.sql) in two places:
--   * NO idempotencyKeyHash / requestBodyHash columns. An Idempotency-Key DERIVES the run id
--     (`deterministicAgentRunId(tenant, slug, key)`), and the existing unique key
--     `WorkflowRun_session_run_key (tenantId, sessionId, runId)` — with an agent row anchored at
--     sessionId = 'agent-run-' || runId — makes a second start of the same key a unique violation,
--     i.e. idempotency is enforced by Postgres, durably, with no Redis claim. The request-body hash
--     (409 on reuse with another body) and the agent task ride in `_metadata`
--     (`{ requestBodyHash, agentTask }`): bookkeeping, not query keys.
--   * The agent's output is NOT a new column: it is `resultRef = {"kind":"inline","value":…}`, the
--     shape workflow results already use, so the A2 retention purge
--     (`WorkflowRunResultRetentionService`, `workflowRuns.resultRetentionDays`) expires it with no
--     change. The public error is `firstErrorCode` (the message is `runErrorMessage(code)`).
--
-- Prisma shape (workflow-run.prisma — committed on branch task-1038/b6a-agent-run-persistence):
--   enum WorkflowRunKind { WORKFLOW AGENT  @@schema("core") }
--   kind                  WorkflowRunKind @default(WORKFLOW)
--   workflowVersionId     String?          -- NULL for kind = AGENT
--   workflowSlug          String?
--   workflowVersionNumber Int?
--   definitionName        String?
--   agentSlug             String?          -- kind = AGENT only
--   agentVersionId        String?          -- Agent.id of the PUBLISHED row the run resolved
--   agentVersionNumber    Int?
--   @@index([tenantId, kind, startedAt], name: "WorkflowRun_tenant_kind_startedAt_idx")
--   @@index([tenantId, agentSlug], name: "WorkflowRun_tenant_agentSlug_idx")
--
-- Existing rows: every one is a workflow run, takes the DEFAULT 'WORKFLOW', and already satisfies
-- the CHECK (its four workflow columns were NOT NULL until this statement). No backfill.
-- ResourceType: unchanged — `WorkflowRun` is already a member, and agent runs broadcast NO
-- sys-event (the `workflow.run.completed` webhook stays a workflow event).

-- CreateEnum
CREATE TYPE "core"."WorkflowRunKind" AS ENUM ('WORKFLOW', 'AGENT');

-- AlterTable
ALTER TABLE "core"."WorkflowRun"
  ADD COLUMN "kind" "core"."WorkflowRunKind" NOT NULL DEFAULT 'WORKFLOW',
  ADD COLUMN "agentSlug" TEXT,
  ADD COLUMN "agentVersionId" TEXT,
  ADD COLUMN "agentVersionNumber" INTEGER,
  ALTER COLUMN "workflowVersionId" DROP NOT NULL,
  ALTER COLUMN "workflowSlug" DROP NOT NULL,
  ALTER COLUMN "workflowVersionNumber" DROP NOT NULL,
  ALTER COLUMN "definitionName" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_kind_startedAt_idx" ON "core"."WorkflowRun"("tenantId", "kind", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_agentSlug_idx" ON "core"."WorkflowRun"("tenantId", "agentSlug");

-- Hand-appended (not emitted by Prisma): a row names exactly ONE identity, by kind. The domain
-- twin is `WorkflowRunEntity.validate()`.
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

-- Readers (all changed on the same branch to filter kind):
--   WorkflowRunRepository.findByRunKey            → kind = 'WORKFLOW' (every workflow by-run-key path)
--   WorkflowRunService.listRuns                   → kind = 'WORKFLOW' (admin runs list)
--   ConsultationReadService (governing run read)  → kind = 'WORKFLOW'
--   MeteringService WORKFLOW_INVOCATIONS count    → kind = 'WORKFLOW'
--   WorkflowRunRepository.findAgentRun            → kind = 'AGENT' (the /agents/:slug/runs routes)
-- Deliberately NOT filtered: the result-retention purge (expires agent results too — OD-25), the
-- storage snapshot byte sum (agent results are inline; they contribute 0 bytes of object storage),
-- the tenant-checkpoint capture (captures the whole table) and its post-commit CANCEL (keyed on a
-- consultation's governing workflow run id, which no agent row carries).
