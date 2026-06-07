-- CreateEnum
CREATE TYPE "core"."KnowledgeDocumentStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "core"."KnowledgeDocument" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "core"."KnowledgeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3),
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."KnowledgeChunk" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "knowledgeDocumentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "qdrantPointId" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingDim" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenantId_idx" ON "core"."KnowledgeDocument"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenant_status_idx" ON "core"."KnowledgeDocument"("tenantId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenant_checksum_idx" ON "core"."KnowledgeDocument"("tenantId", "checksum");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenantId_idx" ON "core"."KnowledgeChunk"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_knowledgeDocumentId_idx" ON "core"."KnowledgeChunk"("knowledgeDocumentId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenant_document_idx" ON "core"."KnowledgeChunk"("tenantId", "knowledgeDocumentId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_qdrantPointId_idx" ON "core"."KnowledgeChunk"("qdrantPointId");

-- AddForeignKey
ALTER TABLE "core"."KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_knowledgeDocumentId_fkey" FOREIGN KEY ("knowledgeDocumentId") REFERENCES "core"."KnowledgeDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
