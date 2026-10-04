-- TASK-1038 OD-26 — PROPOSAL (not applied): let the run read model hold AGENT runs.
--
-- Status: proposal from lane B2 (wave B). NOT a migration and deliberately NOT under
-- packages/database/src/prisma/db_main/migrations/ (rule 02: Prisma applies every folder there).
-- The orchestrator authors the real migration (shadow-DB recipe, rule 02) if the owner accepts it.
--
-- Why: `WorkflowRun` cannot hold an agent run today. `workflowVersionId`, `workflowSlug`,
-- `workflowVersionNumber` and `definitionName` are NOT NULL and name a WORKFLOW, and there is no
-- `kind` column — an agent row written there would masquerade as a workflow run in every runs list
-- and collide with a workflow of the same slug on GET /workflows/{slug}/runs/{runId}.
--
-- Interim (shipped by B2): agent runs live in Redis (`agent:run:<tenantId>:<runId>`, kept
-- `workflowRuns.resultRetentionDays`), events through the ONE run sequencer
-- (`wf:run:<runId>:{seq,events,dedupe}`). See apps/api/src/modules/agent/agent-run.store.ts.
--
-- Prisma shape (workflow-run.prisma), for the record:
--   enum WorkflowRunKind { WORKFLOW AGENT  @@schema("core") }
--   kind                  WorkflowRunKind @default(WORKFLOW)
--   workflowVersionId     String?          -- NULL for kind = AGENT
--   workflowSlug          String?
--   workflowVersionNumber Int?
--   definitionName        String?
--   agentSlug             String?          -- kind = AGENT only
--   agentVersionId        String?          -- Agent.id of the PUBLISHED row the run resolved
--   agentVersionNumber    Int?
--   idempotencyKeyHash    String?          -- sha-256 of the caller's Idempotency-Key (never the key)
--   requestBodyHash       String?          -- sha-256 of the canonical body (409 on reuse with another body)
--   @@index([tenantId, kind, startedAt], name: "WorkflowRun_tenant_kind_startedAt_idx")
--   @@index([tenantId, agentSlug], name: "WorkflowRun_tenant_agentSlug_idx")
--   @@unique([tenantId, idempotencyKeyHash], map: "WorkflowRun_tenant_idempotency_key")  -- partial in SQL below

CREATE TYPE "core"."WorkflowRunKind" AS ENUM ('WORKFLOW', 'AGENT');

ALTER TABLE "core"."WorkflowRun"
  ADD COLUMN "kind" "core"."WorkflowRunKind" NOT NULL DEFAULT 'WORKFLOW',
  ADD COLUMN "agentSlug" TEXT,
  ADD COLUMN "agentVersionId" TEXT,
  ADD COLUMN "agentVersionNumber" INTEGER,
  ADD COLUMN "idempotencyKeyHash" TEXT,
  ADD COLUMN "requestBodyHash" TEXT,
  ALTER COLUMN "workflowVersionId" DROP NOT NULL,
  ALTER COLUMN "workflowSlug" DROP NOT NULL,
  ALTER COLUMN "workflowVersionNumber" DROP NOT NULL,
  ALTER COLUMN "definitionName" DROP NOT NULL;

-- A row names exactly one identity, by kind.
ALTER TABLE "core"."WorkflowRun" ADD CONSTRAINT "WorkflowRun_kind_identity_check" CHECK (
  ("kind" = 'WORKFLOW' AND "workflowVersionId" IS NOT NULL AND "workflowSlug" IS NOT NULL
                       AND "workflowVersionNumber" IS NOT NULL AND "definitionName" IS NOT NULL
                       AND "agentSlug" IS NULL AND "agentVersionId" IS NULL)
  OR
  ("kind" = 'AGENT' AND "agentSlug" IS NOT NULL AND "agentVersionId" IS NOT NULL AND "agentVersionNumber" IS NOT NULL
                    AND "workflowVersionId" IS NULL AND "workflowSlug" IS NULL)
);

CREATE INDEX "WorkflowRun_tenant_kind_startedAt_idx" ON "core"."WorkflowRun" ("tenantId", "kind", "startedAt");
CREATE INDEX "WorkflowRun_tenant_agentSlug_idx" ON "core"."WorkflowRun" ("tenantId", "agentSlug");
CREATE UNIQUE INDEX "WorkflowRun_tenant_idempotency_key" ON "core"."WorkflowRun" ("tenantId", "idempotencyKeyHash")
  WHERE "idempotencyKeyHash" IS NOT NULL;

-- Readers that list WORKFLOW runs must then filter `kind = 'WORKFLOW'` (the runs list, the trace,
-- GET /workflows/{slug}/runs/{runId}); the agent run routes read `kind = 'AGENT' AND agentSlug = $slug`.
