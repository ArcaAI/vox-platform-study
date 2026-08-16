-- Tenant NLP Task Instructions: tenant-writable topic/intent instruction
-- content for `nlp.topic`/`nlp.intent` (TASK-729).
--
-- Additive only: no existing table or column is touched.

-- AlterEnum
-- Audit resource type for the instructions row. MUST stay in lock-step with
-- packages/domains/src/enums/generated/ResourceType.ts — omitting it makes
-- every AuditLog INSERT for this resource throw and rolls the originating
-- mutation into a 500 (guard: resourceType.enum-parity.test.ts). Safe inside
-- the migration transaction (PostgreSQL >= 12 allows ADD VALUE in a
-- transaction block provided the new value is not USED in the same
-- transaction — nothing below writes it).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantNlpTaskInstructions';

-- CreateTable
CREATE TABLE "core"."TenantNlpTaskInstructions" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "instructionsJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantNlpTaskInstructions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantNlpTaskInstructions_tenantId_idx" ON "core"."TenantNlpTaskInstructions"("tenantId");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "TenantNlpTaskInstructions_tenant_task_unique" ON "core"."TenantNlpTaskInstructions"("tenantId", "taskKey");
