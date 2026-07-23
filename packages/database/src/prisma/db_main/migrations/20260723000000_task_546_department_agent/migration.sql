-- TASK-546 — DepartmentAgent: first-class agent entity.
--
-- Binds a tenant department to a PromptTemplate at a pinned or tracked version,
-- plus a DNA-style gate, (later) harness overrides and a golden set. Standard
-- tenant-scoped config model (tenantId + resourceStatus soft-delete + _version
-- OCC + audit). Registered in TENANT_SCOPED_MODELS (NOT SYSTEM-shared) and NOT
-- in MODELS_WITHOUT_SOFT_DELETE (it HAS soft delete).
--
-- Template lineage columns (`sourceAgentTemplateSlug`, `templateLocked`) mirror
-- the AsrPipeline pattern (TASK-531); consumption lands in TASK-548 but the
-- columns are provisioned now so no later migration is needed.

-- ResourceType is emitted by DepartmentAgentService.broadcastSysEvent — without
-- this every AuditLog INSERT for the model would throw and roll back the
-- originating mutation (the TASK-366 failure mode). IF NOT EXISTS + Postgres
-- cannot drop an enum value, so this is append-only and idempotent.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'DepartmentAgent';

-- CreateEnum
CREATE TYPE "core"."DepartmentAgentDnaPolicy" AS ENUM ('INHERIT', 'DISABLED');

-- CreateTable
CREATE TABLE "core"."DepartmentAgent" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "promptTemplateId" TEXT NOT NULL,
    "pinnedVersionNumber" INTEGER,
    "dnaStylePolicy" "core"."DepartmentAgentDnaPolicy" NOT NULL DEFAULT 'INHERIT',
    "harnessOverrides" JSONB,
    "goldenSetId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sourceAgentTemplateSlug" TEXT,
    "templateLocked" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "DepartmentAgent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DepartmentAgent_tenantId_idx" ON "core"."DepartmentAgent"("tenantId");

-- CreateIndex
CREATE INDEX "DepartmentAgent_departmentId_idx" ON "core"."DepartmentAgent"("departmentId");

-- CreateIndex
CREATE INDEX "DepartmentAgent_promptTemplateId_idx" ON "core"."DepartmentAgent"("promptTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentAgent_tenant_dept_slug_key" ON "core"."DepartmentAgent"("tenantId", "departmentId", "slug");

-- AddForeignKey
ALTER TABLE "core"."DepartmentAgent" ADD CONSTRAINT "DepartmentAgent_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."DepartmentAgent" ADD CONSTRAINT "DepartmentAgent_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "core"."PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
