-- TASK-863 — Agent: a first-class, task-typed, publishable entity.
--
-- Everything above the "hand-written" marker below is the literal output of
-- `prisma migrate diff --from-schema <dev-2.2 schema> --to-schema src/prisma/db_main --script`.
-- Everything below it is hand-written because the Prisma DSL cannot express it
-- (partial unique index, triggers) — the workflow_definition_immutability_guard
-- precedent (20260817000100_task_734_...). `prisma migrate diff` will therefore
-- show permanent drift for exactly those objects; that is expected.
--
◇ injected env (163) from ../../.env.dev // tip: ⌘ multiple files { path: ['.env.local', '.env'] }
-- CreateEnum
CREATE TYPE "core"."AgentTask" AS ENUM ('SPEECH_TO_TEXT', 'TEXT_GENERATION', 'TEXT_TO_SPEECH');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "core"."ResourceType" ADD VALUE 'Agent';
ALTER TYPE "core"."ResourceType" ADD VALUE 'AgentAssignment';

-- CreateTable
CREATE TABLE "core"."Agent" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "task" "core"."AgentTask" NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "parentVersionId" TEXT,
    "status" "core"."WorkflowDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "modelId" TEXT NOT NULL,
    "instruction" JSONB,
    "parameters" JSONB,
    "inputSchema" JSONB,
    "outputSchema" JSONB,
    "tools" JSONB,
    "compiledConfig" JSONB,
    "compiledConfigChecksum" TEXT,
    "validationReport" JSONB,
    "validatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AgentModelFallback" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "modelId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentModelFallback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AgentAssignment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "task" "core"."AgentTask" NOT NULL,
    "agentSlug" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AgentAssignmentChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "task" "core"."AgentTask" NOT NULL,
    "changedBy" TEXT,
    "assignmentVersion" INTEGER,
    "beforeSlug" TEXT,
    "afterSlug" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAssignmentChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Agent_tenantId_idx" ON "core"."Agent"("tenantId");

-- CreateIndex
CREATE INDEX "Agent_tenant_task_idx" ON "core"."Agent"("tenantId", "task");

-- CreateIndex
CREATE INDEX "Agent_tenant_slug_isActive_idx" ON "core"."Agent"("tenantId", "slug", "isActive");

-- CreateIndex
CREATE INDEX "Agent_tenant_slug_status_idx" ON "core"."Agent"("tenantId", "slug", "status");

-- CreateIndex
CREATE INDEX "Agent_modelId_idx" ON "core"."Agent"("modelId");

-- CreateIndex
CREATE INDEX "Agent_parentVersionId_idx" ON "core"."Agent"("parentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_tenant_slug_version_unique" ON "core"."Agent"("tenantId", "slug", "versionNumber");

-- CreateIndex
CREATE INDEX "AgentModelFallback_tenantId_idx" ON "core"."AgentModelFallback"("tenantId");

-- CreateIndex
CREATE INDEX "AgentModelFallback_agentId_idx" ON "core"."AgentModelFallback"("agentId");

-- CreateIndex
CREATE INDEX "AgentModelFallback_modelId_idx" ON "core"."AgentModelFallback"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentModelFallback_agent_priority_unique" ON "core"."AgentModelFallback"("agentId", "priority");

-- CreateIndex
CREATE INDEX "AgentAssignment_tenantId_idx" ON "core"."AgentAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "AgentAssignment_tenant_task_idx" ON "core"."AgentAssignment"("tenantId", "task");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAssignment_scope_task_unique" ON "core"."AgentAssignment"("tenantId", "scope", "scopeId", "task");

-- CreateIndex
CREATE INDEX "AgentAssignmentChange_tenantId_idx" ON "core"."AgentAssignmentChange"("tenantId");

-- CreateIndex
CREATE INDEX "AgentAssignmentChange_tenant_createdAt_idx" ON "core"."AgentAssignmentChange"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "core"."Agent" ADD CONSTRAINT "Agent_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "core"."AiModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."AgentModelFallback" ADD CONSTRAINT "AgentModelFallback_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "core"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."AgentModelFallback" ADD CONSTRAINT "AgentModelFallback_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "core"."AiModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Hand-written from here (not expressible in the Prisma schema DSL).
-- ============================================================================

-- 1. At most one ACTIVE, non-deleted version per (tenantId, slug) — the movable
--    pointer the resolver serves. Mirrors WorkflowDefinition_tenant_slug_active_unique.
CREATE UNIQUE INDEX "Agent_tenant_slug_active_unique"
ON "core"."Agent" ("tenantId", "slug")
WHERE "isActive" = true AND "resourceStatus" != 'DELETED';

-- 2. PUBLISHED/DEPRECATED agent rows are hard-immutable for their published
--    BYTES (compiledConfig + checksum, the model binding, the authored config
--    columns) and lineage identity. `status`, `isActive`, `deprecatedAt`,
--    `validationReport`, name/description/tags, resourceStatus* and the audit
--    columns stay writable (deprecate / demote / soft-delete are legitimate).
--    Gated on OLD.status, deliberately never NEW.status. Hard DELETE of such a
--    row is refused outright — use softDelete().
CREATE OR REPLACE FUNCTION "core"."agent_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('PUBLISHED', 'DEPRECATED') THEN
      RAISE EXCEPTION 'Agent %: hard delete of a % row is forbidden — use softDelete()', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" IN ('PUBLISHED', 'DEPRECATED') THEN
    IF NEW."compiledConfig" IS DISTINCT FROM OLD."compiledConfig"
      OR NEW."compiledConfigChecksum" IS DISTINCT FROM OLD."compiledConfigChecksum"
      OR NEW."modelId" IS DISTINCT FROM OLD."modelId"
      OR NEW."task" IS DISTINCT FROM OLD."task"
      OR NEW."instruction" IS DISTINCT FROM OLD."instruction"
      OR NEW."parameters" IS DISTINCT FROM OLD."parameters"
      OR NEW."inputSchema" IS DISTINCT FROM OLD."inputSchema"
      OR NEW."outputSchema" IS DISTINCT FROM OLD."outputSchema"
      OR NEW."tools" IS DISTINCT FROM OLD."tools"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."slug" IS DISTINCT FROM OLD."slug"
      OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
      OR NEW."parentVersionId" IS DISTINCT FROM OLD."parentVersionId"
      OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
    THEN
      RAISE EXCEPTION 'Agent %: the published configuration (model binding, instruction, parameters, I/O schemas, tools, compiledConfig) and lineage identity are immutable once status=% — branch a new version instead', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."Agent"
FOR EACH ROW
EXECUTE FUNCTION "core"."agent_immutability_guard"();

-- 3. The fallback chain of a PUBLISHED/DEPRECATED agent is part of its published
--    bytes: refuse any UPDATE/DELETE of an AgentModelFallback row whose agent is
--    no longer a draft (a row-level DELETE is still allowed to CASCADE from a
--    hard-deleted DRAFT agent, which the guard above permits).
CREATE OR REPLACE FUNCTION "core"."agent_model_fallback_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status TEXT;
BEGIN
  SELECT "status"::text INTO parent_status FROM "core"."Agent" WHERE "id" = OLD."agentId";
  IF parent_status IN ('PUBLISHED', 'DEPRECATED') THEN
    RAISE EXCEPTION 'AgentModelFallback %: the fallback chain of a % agent is immutable — branch a new version instead', OLD."id", parent_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_model_fallback_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."AgentModelFallback"
FOR EACH ROW
EXECUTE FUNCTION "core"."agent_model_fallback_immutability_guard"();

-- 4. AgentAssignmentChange is WORM. Its sibling WorkflowAssignmentChange relies
--    on application discipline alone (its migration deliberately declined to
--    invent a role name to REVOKE from); this table gets a role-independent
--    trigger instead, so append-only holds under any deployment's role names.
CREATE OR REPLACE FUNCTION "core"."agent_assignment_change_worm_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AgentAssignmentChange %: rows are append-only (WORM); % is forbidden', OLD."id", TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "agent_assignment_change_worm_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."AgentAssignmentChange"
FOR EACH ROW
EXECUTE FUNCTION "core"."agent_assignment_change_worm_guard"();
