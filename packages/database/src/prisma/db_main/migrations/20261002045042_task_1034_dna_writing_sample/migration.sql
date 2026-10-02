-- CreateEnum
CREATE TYPE "core"."DnaSampleSource" AS ENUM ('EDIT', 'SIGNOFF', 'INGEST');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'DnaWritingSample';

-- CreateTable
CREATE TABLE "core"."DnaWritingSample" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "source" "core"."DnaSampleSource" NOT NULL,
    "textCiphertext" BYTEA NOT NULL,
    "aiDraftCiphertext" BYTEA,
    "keyVersion" INTEGER,
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT,
    "sourceRef" TEXT,
    "contentHash" TEXT NOT NULL,
    "ingestBatchId" TEXT,
    "consultationId" TEXT,
    "contextItemId" TEXT,
    "consumedByReportId" TEXT,
    "consumedAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DnaWritingSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DnaWritingSample_tenantId_idx" ON "core"."DnaWritingSample"("tenantId");

-- CreateIndex
CREATE INDEX "DnaWritingSample_tenant_doctor_createdAt_idx" ON "core"."DnaWritingSample"("tenantId", "doctorId", "createdAt");

-- CreateIndex
CREATE INDEX "DnaWritingSample_tenant_doctor_hash_idx" ON "core"."DnaWritingSample"("tenantId", "doctorId", "contentHash");
