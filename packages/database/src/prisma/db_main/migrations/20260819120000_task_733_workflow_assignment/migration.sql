-- half (a) — per-department workflow assignment.
--
-- Two additive tables plus one enum value. Nothing existing is touched.
--
--   WorkflowAssignment — (tenantId, scope, scopeId, paletteKey) ->
--                               workflowDefinitionSlug. Shaped exactly like
--                               PipelinePolicy so the same walkCascade
--                               primitive resolves it (department -> tenant ->
--                               platform default).
--   WorkflowAssignmentChange — the append-only WORM change log, mirroring
--                               PipelinePolicyChange.
--
-- NOTE on WORM enforcement: PipelinePolicyChange / HarnessPolicyChange were
-- originally created with a `REVOKE UPDATE, DELETE` for the application role,
-- but that grant DDL did not survive the 2026-08-17 migration squash
-- (20260817000000_init was produced by `migrate diff --from-empty`, which can
-- only emit schema-DSL-expressible objects; see
-- 20260817000200_restore_squash_dropped_ddl for the other casualties). This
-- migration deliberately does NOT invent a role name to revoke from — the
-- append-only property is enforced here the same way it is for those two
-- siblings today: the repository exposes no update/delete surface and the
-- service only ever `create`s. Restoring the DB-privilege layer for all three
-- change logs at once is a follow-up, not a side effect.

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'WorkflowAssignment';

-- CreateTable
CREATE TABLE "core"."WorkflowAssignment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "paletteKey" TEXT NOT NULL,
    "workflowDefinitionSlug" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."WorkflowAssignmentChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "paletteKey" TEXT NOT NULL,
    "changedBy" TEXT,
    "assignmentVersion" INTEGER,
    "beforeSlug" TEXT,
    "afterSlug" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowAssignmentChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAssignment_scope_palette_unique" ON "core"."WorkflowAssignment"("tenantId", "scope", "scopeId", "paletteKey");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_tenantId_idx" ON "core"."WorkflowAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowAssignment_tenant_palette_idx" ON "core"."WorkflowAssignment"("tenantId", "paletteKey");

-- CreateIndex
CREATE INDEX "WorkflowAssignmentChange_tenantId_idx" ON "core"."WorkflowAssignmentChange"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowAssignmentChange_tenant_createdAt_idx" ON "core"."WorkflowAssignmentChange"("tenantId", "createdAt");
