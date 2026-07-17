-- TASK-506 — AI model registry consolidation groundwork.
-- Additive only: one enum value, two nullable AiModel columns + index, and the
-- new AiTaskDefault per-tenant task-default table. Dev/test DBs are
-- `db push`-managed and behind migration history — apply this file via psql
-- (see docs/implementation/TASK-506-AI-Model-Registry-Consolidation/README.md);
-- production applies it through `pnpm db:migrate:deploy`.

-- AlterEnum
ALTER TYPE "core"."AiModelFormat" ADD VALUE 'CLOUD_API';

-- AlterEnum — audit ResourceType for AiTaskDefaultService broadcastSysEvent
-- writes (TASK-366/TASK-498 pattern: a missing value fails the AuditLog write
-- and therefore the originating mutation).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'AiTaskDefault';

-- AlterTable
ALTER TABLE "core"."AiModel" ADD COLUMN "provider" TEXT,
ADD COLUMN "architecture" TEXT;

-- CreateIndex
CREATE INDEX "AiModel_provider_idx" ON "core"."AiModel"("provider");

-- CreateTable
CREATE TABLE "core"."AiTaskDefault" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL,
    "configJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiTaskDefault_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiTaskDefault_tenant_task_unique" ON "core"."AiTaskDefault"("tenantId", "taskKey");

-- CreateIndex
CREATE INDEX "AiTaskDefault_tenantId_idx" ON "core"."AiTaskDefault"("tenantId");

-- CreateIndex
CREATE INDEX "AiTaskDefault_taskKey_idx" ON "core"."AiTaskDefault"("taskKey");
