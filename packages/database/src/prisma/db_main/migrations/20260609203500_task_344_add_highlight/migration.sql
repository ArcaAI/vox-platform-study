-- Manual doctor highlighting (durable Highlight model).
--
-- PURELY ADDITIVE. One new enum + one new table + four indexes + one FK.
-- No DROP / DELETE / TRUNCATE / column removal / ALTER … DROP on any existing
-- table or column. The Consultation.Highlights relation is virtual (no column),
-- so the only DB change to an existing object is the additive FK constraint that
-- lives on the NEW Highlight table.

-- CreateEnum
CREATE TYPE "core"."HighlightTargetKind" AS ENUM ('TRANSCRIPT', 'CASE_NOTE', 'WORKNOTE', 'SUMMARY');

-- CreateTable
CREATE TABLE "core"."Highlight" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "sourceContextItemId" TEXT,
    "targetKind" "core"."HighlightTargetKind" NOT NULL,
    "exact" TEXT NOT NULL,
    "prefix" TEXT,
    "suffix" TEXT,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "color" TEXT,
    "label" TEXT,
    "note" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Highlight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Highlight_tenantId_idx" ON "core"."Highlight"("tenantId");

-- CreateIndex
CREATE INDEX "Highlight_consultationId_idx" ON "core"."Highlight"("consultationId");

-- CreateIndex
CREATE INDEX "Highlight_sourceContextItemId_idx" ON "core"."Highlight"("sourceContextItemId");

-- CreateIndex
CREATE INDEX "Highlight_tenant_consultation_idx" ON "core"."Highlight"("tenantId", "consultationId");

-- AddForeignKey
ALTER TABLE "core"."Highlight" ADD CONSTRAINT "Highlight_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "core"."Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
