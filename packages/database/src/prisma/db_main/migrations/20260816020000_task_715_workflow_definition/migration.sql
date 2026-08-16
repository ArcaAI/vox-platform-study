-- Workflow Definition: the persistence and vocabulary floor of the
-- agentic-workflow-platform substrate (TASK-715).
--
-- Adds a SINGLE new table whose rows ARE versions (no separate head +
-- immutable-version-snapshot + movable-pin split — see the header comment in
-- workflow-definition.prisma for why this ticket deliberately diverges from
-- the house governance triple), plus the two enum additions it needs.
--
-- Additive only: no existing table or column is touched.

-- CreateEnum
CREATE TYPE "core"."WorkflowDefinitionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'DEPRECATED');

-- AlterEnum
-- Audit resource type for the definition row. MUST stay in lock-step with
-- packages/domains/src/enums/generated/ResourceType.ts — omitting it makes
-- every AuditLog INSERT for this resource throw and rolls the originating
-- mutation into a 500 (guard: resourceType.enum-parity.test.ts). Safe inside
-- the migration transaction (PostgreSQL >= 12 allows ADD VALUE in a
-- transaction block provided the new value is not USED in the same
-- transaction — nothing below writes it).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'WorkflowDefinition';

-- CreateTable
CREATE TABLE "core"."WorkflowDefinition" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "paletteKey" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "parentVersionId" TEXT,
    "status" "core"."WorkflowDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "graph" JSONB NOT NULL,
    "graphChecksum" TEXT NOT NULL,
    "compiledConfig" JSONB,
    "compiledConfigChecksum" TEXT,
    "registryChecksum" TEXT,
    "validationReport" JSONB,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "validatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_idx" ON "core"."WorkflowDefinition"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenant_slug_status_idx" ON "core"."WorkflowDefinition"("tenantId", "slug", "status");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenant_slug_isActive_idx" ON "core"."WorkflowDefinition"("tenantId", "slug", "isActive");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_parentVersionId_idx" ON "core"."WorkflowDefinition"("parentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_tenant_slug_version_unique" ON "core"."WorkflowDefinition"("tenantId", "slug", "versionNumber");
