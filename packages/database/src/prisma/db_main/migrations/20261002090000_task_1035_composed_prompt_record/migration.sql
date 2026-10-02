-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'ComposedPromptRecord';

-- CreateTable
CREATE TABLE "core"."ComposedPromptRecord" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT,
    "agentSlug" TEXT,
    "phase" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "locality" TEXT NOT NULL,
    "systemCiphertext" BYTEA NOT NULL,
    "userCiphertext" BYTEA NOT NULL,
    "keyVersion" INTEGER,
    "sha256" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComposedPromptRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ComposedPromptRecord_tenantId_idx" ON "core"."ComposedPromptRecord"("tenantId");

-- CreateIndex
CREATE INDEX "ComposedPromptRecord_tenant_consultation_createdAt_idx" ON "core"."ComposedPromptRecord"("tenantId", "consultationId", "createdAt");

-- CreateIndex
CREATE INDEX "ComposedPromptRecord_createdAt_idx" ON "core"."ComposedPromptRecord"("createdAt");
