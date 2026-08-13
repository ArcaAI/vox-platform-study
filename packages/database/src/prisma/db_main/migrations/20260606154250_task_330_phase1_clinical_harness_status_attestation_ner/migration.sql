-- Clinical Documentation Harness (TypeScript core).
--
-- PURELY ADDITIVE. No DROP / DELETE / TRUNCATE / column removal / ALTER … DROP.
-- Generated from `prisma migrate diff` (snapshot → edited schema) and then
-- hand-augmented with (a) an idempotent enum ADD VALUE and (b) a NON-destructive
-- backfill of the new `Consultation.status` from the legacy `metadata.status`
-- JSON. The backfill only WRITES the new column; it never mutates `metadata`.
--
-- Promotes the consultation lifecycle to a typed column, adds clinician
-- attestation fields, NER ontology codes + transcript spans, and summary
-- sensor/citation provenance.

-- AlterEnum (additive; idempotent so it is safe on the drifted dev DB)
ALTER TYPE "core"."ContextItemType" ADD VALUE IF NOT EXISTS 'SIGNED_NOTE';

-- CreateEnum
CREATE TYPE "core"."ConsultationStatus" AS ENUM ('OPEN', 'RECORDING', 'PENDING_REVIEW', 'SIGNED', 'CLOSED', 'REOPENED');

-- AlterTable (NOT NULL + DEFAULT 'OPEN' ⇒ existing rows are filled with the
-- default; the backfill below refines them from the legacy JSON status).
ALTER TABLE "core"."Consultation" ADD COLUMN     "status" "core"."ConsultationStatus" NOT NULL DEFAULT 'OPEN';

-- Backfill (NON-destructive): map legacy `metadata.status` strings onto the new
-- typed lifecycle. Unknown / intermediate states (TRANSCRIBING, SUMMARIZING, …)
-- and rows with no status default safely to OPEN. `metadata` is never modified.
UPDATE "core"."Consultation"
SET "status" = (
    CASE upper(coalesce("metadata"->>'status', 'OPEN'))
        WHEN 'OPEN'           THEN 'OPEN'
        WHEN 'RECORDING'      THEN 'RECORDING'
        WHEN 'PENDING_REVIEW' THEN 'PENDING_REVIEW'
        WHEN 'REVIEW'         THEN 'PENDING_REVIEW'
        WHEN 'SIGNED'         THEN 'SIGNED'
        WHEN 'CLOSED'         THEN 'CLOSED'
        WHEN 'REOPENED'       THEN 'REOPENED'
        ELSE 'OPEN'
    END
)::"core"."ConsultationStatus"
WHERE "metadata" IS NOT NULL;

-- AlterTable
ALTER TABLE "core"."SummaryMeta" ADD COLUMN     "attestationRef" TEXT,
ADD COLUMN     "citationsMap" JSONB,
ADD COLUMN     "coverageScore" DOUBLE PRECISION,
ADD COLUMN     "entityFaithfulnessScore" DOUBLE PRECISION,
ADD COLUMN     "guardrailDecisions" JSONB,
ADD COLUMN     "modelName" TEXT,
ADD COLUMN     "ragTriadScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "core"."NamedEntity" ADD COLUMN     "icdCode" TEXT,
ADD COLUMN     "loincCode" TEXT,
ADD COLUMN     "rxnormCode" TEXT,
ADD COLUMN     "snomedCode" TEXT,
ADD COLUMN     "transcriptContextItemId" TEXT,
ADD COLUMN     "transcriptEndOffset" INTEGER,
ADD COLUMN     "transcriptStartOffset" INTEGER,
ADD COLUMN     "umlsCui" TEXT;

-- AlterTable
ALTER TABLE "core"."ContextItemVersion" ADD COLUMN     "attestationHash" TEXT,
ADD COLUMN     "attestedAt" TIMESTAMP(3),
ADD COLUMN     "attestedBy" TEXT,
ADD COLUMN     "modelName" TEXT,
ADD COLUMN     "modelVersion" TEXT,
ADD COLUMN     "sensorScores" JSONB;

-- CreateIndex
CREATE INDEX "Consultation_tenant_status_idx" ON "core"."Consultation"("tenantId", "status");

-- CreateIndex
CREATE INDEX "NamedEntity_transcriptContextItem_idx" ON "core"."NamedEntity"("transcriptContextItemId");

-- AddForeignKey
ALTER TABLE "core"."NamedEntity" ADD CONSTRAINT "NamedEntity_transcriptContextItemId_fkey" FOREIGN KEY ("transcriptContextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
