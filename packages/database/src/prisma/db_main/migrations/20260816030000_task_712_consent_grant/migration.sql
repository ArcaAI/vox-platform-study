-- Consent & ABAC (TASK-712) — the ConsentGrant model and its two enums.
--
-- This migration is authored by hand against the shadow-DB recipe in
-- .claude/rules/02-database-prisma.md §Migration Workflow, but has NOT been
-- applied or diffed against a live database in this session (local infra is
-- down — no Postgres reachable). It has NOT been run through
-- `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script`
-- to prove an empty diff. Whoever next has database access MUST run that
-- proof before this migration is considered verified — see
-- docs/implementation/TASK-712-Consent-Abac/README.md §5 Acceptance Criteria.
--
-- Additive only: no existing table, column, or enum value is altered or
-- dropped. `ConsentGrant` carries NO enforcement — nothing in this phase
-- reads from or writes consent decisions off of it end-to-end; see
-- docs/implementation/TASK-712-Consent-Abac/consent-design.md.

-- CreateEnum
CREATE TYPE "core"."ConsentPurpose" AS ENUM ('AI_DOCUMENTATION', 'HISTORY_RETRIEVAL', 'EXTERNAL_TOOL_LOOKUP', 'STYLE_LEARNING', 'QUALITY_REVIEW');

-- CreateEnum
CREATE TYPE "core"."ConsentGrantMethod" AS ENUM ('VERBAL_ATTESTED', 'WRITTEN', 'PORTAL', 'IMPORTED');

-- AlterEnum
-- Audit resource type for ConsentGrant create/revoke. MUST stay in
-- lock-step with packages/domains/src/enums/generated/ResourceType.ts —
-- omitting it makes every AuditLog INSERT for this resource throw and rolls
-- the originating mutation into a 500 (guard: resourceType.enum-parity.test.ts).
-- Safe inside the migration transaction (PostgreSQL >= 12 allows ADD VALUE in
-- a transaction block provided the new value is not USED in the same
-- transaction — nothing below writes it).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'ConsentGrant';

-- CreateTable
CREATE TABLE "core"."ConsentGrant" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalPatientId" TEXT NOT NULL,
    "purpose" "core"."ConsentPurpose" NOT NULL,
    "scope" JSONB,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantMethod" "core"."ConsentGrantMethod" NOT NULL,
    "evidenceRef" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revocationReason" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConsentGrant_tenantId_idx" ON "core"."ConsentGrant"("tenantId");

-- CreateIndex
CREATE INDEX "ConsentGrant_tenant_patient_idx" ON "core"."ConsentGrant"("tenantId", "externalPatientId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentGrant_tenant_patient_purpose_key" ON "core"."ConsentGrant"("tenantId", "externalPatientId", "purpose");
