-- ============================================================================
-- TASK-1050 W0 — DRAFT of the expected migration (NOT a migration; never copy
-- this folder into migrations/). The orchestrator authors the real migration on
-- a shadow DB after the merge (rule 02 recipe):
--
--   pnpm --filter @arcaai/database db:migrate:create -n task_1050_guardrail_evaluation
--
-- then diffs the generated SQL against this draft and APPENDS the hand-written
-- section at the bottom (partial index + optional WORM triggers), which the
-- Prisma DSL cannot express. Prisma's own generated SQL wins wherever the two
-- disagree on the DSL-expressible part.
-- ============================================================================

-- CreateEnum
CREATE TYPE "core"."GuardrailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "core"."GuardrailDecision" AS ENUM ('ALLOW', 'WARN', 'BLOCK', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "core"."GuardrailNoticeType" AS ENUM ('WARNING', 'BLOCKED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "core"."GuardrailNoticeStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "core"."GuardrailItemStatus" AS ENUM ('CLEAN', 'WARNED', 'BLOCKED', 'WITHHELD');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'GuardrailEvaluation';
ALTER TYPE "core"."ResourceType" ADD VALUE 'GuardrailNotice';
ALTER TYPE "core"."ResourceType" ADD VALUE 'GuardrailPolicyRevision';

-- AlterTable — side-channel marker, outside OCC (OD-21). Backfill-free: every
-- existing row reads CLEAN. On PG >= 11 a constant DEFAULT is a metadata-only
-- change, so this does not rewrite ContextItem.
ALTER TABLE "core"."ContextItem" ADD COLUMN "guardrailStatus" "core"."GuardrailItemStatus" NOT NULL DEFAULT 'CLEAN';

-- CreateTable
CREATE TABLE "core"."GuardrailEvaluation" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "consultationId" TEXT,
    "runId" TEXT,
    "runKey" TEXT,
    "nodeId" TEXT,
    "agentSlug" TEXT,
    "caller" TEXT NOT NULL,
    "direction" "core"."GuardrailDirection" NOT NULL,
    "decision" "core"."GuardrailDecision" NOT NULL,
    "exempt" TEXT,
    "checks" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "noticeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedWithheldContent" BYTEA,
    "keyVersion" INTEGER,
    "at" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GuardrailNotice" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT,
    "runId" TEXT,
    "nodeId" TEXT,
    "type" "core"."GuardrailNoticeType" NOT NULL,
    "direction" "core"."GuardrailDirection" NOT NULL,
    "action" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "itemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "messageKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "requiresAcknowledgement" BOOLEAN NOT NULL DEFAULT false,
    "resumable" BOOLEAN NOT NULL DEFAULT false,
    "policyVersion" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "core"."GuardrailNoticeStatus" NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedVia" TEXT,
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GuardrailPolicyRevision" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aiModelId" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "valueHash" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "restoredFromRevisionId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailPolicyRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_tenant_consultation_at_idx" ON "core"."GuardrailEvaluation"("tenantId", "consultationId", "at");

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_tenant_at_idx" ON "core"."GuardrailEvaluation"("tenantId", "at");

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_runKey_idx" ON "core"."GuardrailEvaluation"("runKey");

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_requestId_idx" ON "core"."GuardrailEvaluation"("requestId");

-- CreateIndex
CREATE INDEX "GuardrailNotice_tenant_consultation_status_idx" ON "core"."GuardrailNotice"("tenantId", "consultationId", "status");

-- CreateIndex
CREATE INDEX "GuardrailNotice_tenant_run_idx" ON "core"."GuardrailNotice"("tenantId", "runId");

-- CreateIndex  (map: name from @@unique — NOT the `name:` client key, rule 02 trap)
CREATE UNIQUE INDEX "GuardrailNotice_tenantId_dedupeKey_key" ON "core"."GuardrailNotice"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "GuardrailPolicyRevision_model_key_at_idx" ON "core"."GuardrailPolicyRevision"("aiModelId", "policyKey", "at");

-- CreateIndex
CREATE INDEX "GuardrailPolicyRevision_tenantId_idx" ON "core"."GuardrailPolicyRevision"("tenantId");

-- ============================================================================
-- HAND-WRITTEN (append to the generated migration; inexpressible in Prisma DSL)
-- ============================================================================

-- 1. Violation views (§9.8.2): partial index on non-ALLOW decisions. About 2
--    rows per generation request land here, nearly all ALLOW, so the partial
--    index stays small while serving "warn/block/unverified over time" and the
--    per-consultation Guardrail tab.
--    NOTE: `prisma migrate diff` does not see partial indexes; it will NOT
--    report this as drift (same as AiRoutingPolicy_tenant_task_default_unique).
CREATE INDEX "GuardrailEvaluation_tenant_violation_at_idx"
  ON "core"."GuardrailEvaluation" ("tenantId", "at")
  WHERE "decision" <> 'ALLOW';

-- 2. OPTIONAL (orchestrator / owner decision) — WORM guards, the
--    AgentAssignmentChange precedent (role-independent trigger). Both tables are
--    append-only by design; nothing in the domain layer updates or deletes them.
--    CAUTION for GuardrailEvaluation: OD-16 says retention follows AuditLog. If a
--    retention purge HARD-deletes aged rows, guard UPDATE only (drop `OR DELETE`)
--    or exempt the purge role. GuardrailNotice is NOT append-only (ack/resolve
--    update it) and must NOT get a trigger.
--
-- CREATE OR REPLACE FUNCTION "core"."guardrail_evaluation_worm_guard"()
-- RETURNS TRIGGER
-- LANGUAGE plpgsql
-- AS $$
-- BEGIN
--   RAISE EXCEPTION 'GuardrailEvaluation %: rows are append-only; % is forbidden', OLD."id", TG_OP
--     USING ERRCODE = 'restrict_violation';
-- END;
-- $$;
--
-- CREATE TRIGGER "guardrail_evaluation_worm_guard_trigger"
-- BEFORE UPDATE ON "core"."GuardrailEvaluation"
-- FOR EACH ROW
-- EXECUTE FUNCTION "core"."guardrail_evaluation_worm_guard"();
--
-- CREATE OR REPLACE FUNCTION "core"."guardrail_policy_revision_worm_guard"()
-- RETURNS TRIGGER
-- LANGUAGE plpgsql
-- AS $$
-- BEGIN
--   RAISE EXCEPTION 'GuardrailPolicyRevision %: rows are append-only (WORM); % is forbidden', OLD."id", TG_OP
--     USING ERRCODE = 'restrict_violation';
-- END;
-- $$;
--
-- CREATE TRIGGER "guardrail_policy_revision_worm_guard_trigger"
-- BEFORE UPDATE OR DELETE ON "core"."GuardrailPolicyRevision"
-- FOR EACH ROW
-- EXECUTE FUNCTION "core"."guardrail_policy_revision_worm_guard"();
