-- Ordered session trajectory (AgentTrajectoryStep).
--
-- Purely ADDITIVE: three new enums + one new table. The table is the ordered,
-- typed, per-session step stream (owner ask 2), tenant-scoped and pruned by
-- retention (hard delete) rather than soft-deleted — hence NO `resourceStatus`
-- column (it is listed in MODELS_WITHOUT_SOFT_DELETE). Stats-first / payload-
-- by-reference: `stats` carries the AD-1 GenerationStats on LLM_CALL steps and
-- `payloadRef` holds only a claim-check ref / encrypted pointer — never
-- plaintext clinical content.
--
-- Additive + idempotent so it is safe to apply via `pnpm db:push` / psql on the
-- db-push-managed dev database (each CREATE is guarded; the enum guards use a
-- pg_type existence check).

-- CreateEnum (idempotent — guard on pg_type so a re-run / db-push is a no-op)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'AgentSessionKind' AND n.nspname = 'core'
  ) THEN
    CREATE TYPE "core"."AgentSessionKind" AS ENUM ('LIVE_DOC', 'HARNESS_DOC', 'SUMMARY_JOB', 'EVAL_RUN');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'AgentStepType' AND n.nspname = 'core'
  ) THEN
    CREATE TYPE "core"."AgentStepType" AS ENUM ('LLM_CALL', 'TOOL_CALL', 'SENSOR', 'RETRIEVAL', 'GUARDRAIL', 'THINKING', 'SIGNAL', 'GATE', 'PHASE');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'AgentStepStatus' AND n.nspname = 'core'
  ) THEN
    CREATE TYPE "core"."AgentStepStatus" AS ENUM ('STARTED', 'OK', 'ERROR', 'SKIPPED', 'TIMEOUT');
  END IF;
END
$$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."AgentTrajectoryStep" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT,
    "sessionKind" "core"."AgentSessionKind" NOT NULL,
    "sessionId" TEXT NOT NULL,
    -- runId is a non-null "" sentinel (NOT nullable) so the composite unique
    -- below stays idempotent for non-Temporal session kinds — Postgres treats
    -- NULLs as distinct, which would silently break ON CONFLICT DO NOTHING.
    "runId" TEXT NOT NULL DEFAULT '',
    "seq" INTEGER NOT NULL,
    "stepType" "core"."AgentStepType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "core"."AgentStepStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "stats" JSONB,
    "payloadRef" JSONB,
    "errorCode" TEXT,
    "correlationId" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTrajectoryStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AgentTrajectoryStep_session_seq_unique" ON "core"."AgentTrajectoryStep"("tenantId", "sessionId", "runId", "seq");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentTrajectoryStep_tenant_consultation_idx" ON "core"."AgentTrajectoryStep"("tenantId", "consultationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AgentTrajectoryStep_tenant_createdAt_idx" ON "core"."AgentTrajectoryStep"("tenantId", "createdAt");
