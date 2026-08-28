-- CreateEnum
CREATE TYPE "core"."DocumentSectionState" AS ENUM ('EMPTY', 'PROVISIONAL', 'CONFIRMED', 'LOCKED');

-- AlterTable
ALTER TABLE "core"."ContextItem" ADD COLUMN     "documentKey" TEXT;

-- CreateTable
CREATE TABLE "core"."DocumentSection" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "documentKey" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "state" "core"."DocumentSectionState" NOT NULL DEFAULT 'EMPTY',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "encryptedContent" BYTEA,
    "contentKeyVersion" INTEGER,
    "annotations" JSONB,
    "provenance" JSONB,
    "documentTemplateVersionId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentSection_tenantId_idx" ON "core"."DocumentSection"("tenantId");

-- CreateIndex
CREATE INDEX "DocumentSection_consultationId_idx" ON "core"."DocumentSection"("consultationId");

-- CreateIndex
CREATE INDEX "DocumentSection_tenant_consultation_document_idx" ON "core"."DocumentSection"("tenantId", "consultationId", "documentKey");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSection_consultation_document_section_key" ON "core"."DocumentSection"("consultationId", "documentKey", "sectionKey");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_documentKey_idx" ON "core"."ContextItem"("consultationId", "documentKey");

-- AddForeignKey
ALTER TABLE "core"."DocumentSection" ADD CONSTRAINT "DocumentSection_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "core"."Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
