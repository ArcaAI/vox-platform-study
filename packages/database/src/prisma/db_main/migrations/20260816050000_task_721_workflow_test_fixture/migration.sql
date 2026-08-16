-- Workflow Test Fixture: per-tenant saved synthetic Workbench test inputs
-- (TASK-721).
--
-- Additive only: no existing table or column is touched.

-- AlterEnum
-- Audit resource type for the fixture row. MUST stay in lock-step with
-- packages/domains/src/enums/generated/ResourceType.ts — omitting it makes
-- every AuditLog INSERT for this resource throw and rolls the originating
-- mutation into a 500 (guard: resourceType.enum-parity.test.ts). Safe inside
-- the migration transaction (PostgreSQL >= 12 allows ADD VALUE in a
-- transaction block provided the new value is not USED in the same
-- transaction — nothing below writes it).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'WorkflowTestFixture';

-- CreateTable
CREATE TABLE "core"."WorkflowTestFixture" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "paletteId" TEXT,
    "workflowDefinitionId" TEXT,
    "input" JSONB NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTestFixture_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowTestFixture_tenantId_idx" ON "core"."WorkflowTestFixture"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowTestFixture_tenant_definition_idx" ON "core"."WorkflowTestFixture"("tenantId", "workflowDefinitionId");
