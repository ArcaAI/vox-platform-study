-- CreateEnum
CREATE TYPE "core"."DocumentTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'APPROVED');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'DocumentTemplate';

-- CreateTable
CREATE TABLE "core"."DocumentTemplate" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "core"."DocumentTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "pinnedVersionNumber" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sourceTemplateSlug" TEXT,
    "templateLocked" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."DocumentTemplateVersion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "shape" JSONB NOT NULL,
    "compiled" JSONB NOT NULL,
    "compilerVersion" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "changeReason" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentTemplate_tenantId_idx" ON "core"."DocumentTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "DocumentTemplate_tenant_isDefault_idx" ON "core"."DocumentTemplate"("tenantId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_tenantId_slug_key" ON "core"."DocumentTemplate"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "DocumentTemplateVersion_tenantId_idx" ON "core"."DocumentTemplateVersion"("tenantId");

-- CreateIndex
CREATE INDEX "DocumentTemplateVersion_templateId_idx" ON "core"."DocumentTemplateVersion"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplateVersion_templateId_versionNumber_key" ON "core"."DocumentTemplateVersion"("templateId", "versionNumber");

-- AddForeignKey
ALTER TABLE "core"."DocumentTemplateVersion" ADD CONSTRAINT "DocumentTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "core"."DocumentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- OD-13 — DB-level immutability guard for DocumentTemplateVersion.
--
-- The `ConsultationContextSchema` precedent this catalog copies has NO trigger
-- and no REVOKE: its version rows are immutable BY CONVENTION ONLY (the
-- repository exposes `.create()`/`.find*()` and nothing else). Only
-- `WorkflowDefinition` carries a DB guard
-- (`workflow_definition_immutability_guard`, migration
-- 20260817000100_task_734_...). This ticket deliberately follows the STRICTER
-- precedent: convention alone is one careless `update()` — a stray admin
-- script, a future call site that forgets the house rule, a `prisma studio`
-- edit — away from rewriting a PUBLISHED clinical template underneath every
-- consultation already pinned to it. Rewriting a discharge-summary shape after
-- documents have been generated against it is not a config change; it is a
-- retroactive edit of the clinical record's provenance.
--
-- Deliberately a TRIGGER rather than `REVOKE UPDATE, DELETE` (HarnessAuditEvent's
-- idiom): REVOKE is role-scoped, so a superuser connection — which is exactly
-- what local development and most back-fill scripts use — bypasses it entirely
-- and the guard could never be proven by a test. A trigger binds every writer.
--
-- Unlike the WorkflowDefinition guard this one is UNCONDITIONAL rather than
-- status-gated, because the two tables differ in kind: WorkflowDefinition rows
-- ARE versions and hold mutable DRAFT rows in the same relation, so its guard
-- has to distinguish them. EVERY row here exists only because a publish minted
-- it, so there is no legitimate in-place write to preserve. The model is listed
-- in MODELS_WITHOUT_SOFT_DELETE, so `softDelete()` throws in the application
-- layer before it could ever reach this table.
--
-- Escape hatch, stated so nobody has to reverse-engineer it: a genuine need to
-- rewrite history is a NEW migration that drops this trigger, does the work,
-- and recreates it — a reviewable, recorded act, which is the whole point.
CREATE OR REPLACE FUNCTION "core"."document_template_version_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DocumentTemplateVersion %: published template versions are immutable — a correction is a new version, never a delete', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RAISE EXCEPTION 'DocumentTemplateVersion %: published template versions are immutable — a correction is a new version, never an update (see document-template.prisma, OD-13)', OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "document_template_version_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."DocumentTemplateVersion"
FOR EACH ROW
EXECUTE FUNCTION "core"."document_template_version_immutability_guard"();
