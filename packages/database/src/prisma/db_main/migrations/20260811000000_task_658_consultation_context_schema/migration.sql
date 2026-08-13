-- Consultation Context Schema: data model, validation, discovery.
--
-- Adds the tenant-declared context-schema plane (a mutable head + immutable
-- published version snapshots), the two tenant-facing discriminator columns on
-- ContextItem, and the two enum values the plane needs.
--
-- Additive only: every new ContextItem column is NULLABLE with no default, so
-- every existing row and every write that names no kind keeps behaving exactly
-- as it does today.

-- CreateEnum
CREATE TYPE "core"."ConsultationContextSchemaScope" AS ENUM ('TENANT', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "core"."ConsultationContextSchemaStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'APPROVED');

-- AlterEnum
-- Tenant-declared structured context. Safe inside the migration transaction
-- (PostgreSQL >= 12 allows ADD VALUE in a transaction block provided the new
-- value is not USED in the same transaction — nothing below writes it).
ALTER TYPE "core"."ContextItemType" ADD VALUE IF NOT EXISTS 'STRUCTURED';

-- AlterEnum
-- Audit resource type for the mutable head row. MUST stay in lock-step with
-- packages/domains/src/enums/generated/ResourceType.ts — omitting it makes
-- every AuditLog INSERT for this resource throw and rolls the originating
-- mutation into a 500 (guard: resourceType.enum-parity.test.ts).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'ConsultationContextSchema';

-- AlterTable
ALTER TABLE "core"."ContextItem" ADD COLUMN     "contextSchemaVersionId" TEXT,
ADD COLUMN     "kindKey" TEXT;

-- CreateTable
CREATE TABLE "core"."ConsultationContextSchema" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "core"."ConsultationContextSchemaScope" NOT NULL DEFAULT 'TENANT',
    "departmentId" TEXT,
    "status" "core"."ConsultationContextSchemaStatus" NOT NULL DEFAULT 'DRAFT',
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

    CONSTRAINT "ConsultationContextSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- Immutable published snapshot: no `resourceStatus`, no `updatedAt`/`updatedBy`
-- by design (listed in MODELS_WITHOUT_SOFT_DELETE). A context item validated
-- against version N must be able to resolve version N forever.
CREATE TABLE "core"."ConsultationContextSchemaVersion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "schemaId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "changeReason" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationContextSchemaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_tenantId_idx" ON "core"."ConsultationContextSchema"("tenantId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_departmentId_idx" ON "core"."ConsultationContextSchema"("departmentId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_tenant_scope_department_idx" ON "core"."ConsultationContextSchema"("tenantId", "scope", "departmentId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_tenant_isDefault_idx" ON "core"."ConsultationContextSchema"("tenantId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationContextSchema_tenantId_slug_key" ON "core"."ConsultationContextSchema"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "ConsultationContextSchemaVersion_tenantId_idx" ON "core"."ConsultationContextSchemaVersion"("tenantId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchemaVersion_schemaId_idx" ON "core"."ConsultationContextSchemaVersion"("schemaId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationContextSchemaVersion_schemaId_versionNumber_key" ON "core"."ConsultationContextSchemaVersion"("schemaId", "versionNumber");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_kindKey_idx" ON "core"."ContextItem"("consultationId", "kindKey");

-- CreateIndex
CREATE INDEX "ContextItem_contextSchemaVersionId_idx" ON "core"."ContextItem"("contextSchemaVersionId");

-- AddForeignKey
ALTER TABLE "core"."ConsultationContextSchema" ADD CONSTRAINT "ConsultationContextSchema_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ConsultationContextSchemaVersion" ADD CONSTRAINT "ConsultationContextSchemaVersion_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "core"."ConsultationContextSchema"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
