-- CreateEnum
CREATE TYPE "core"."GovernedPromptPieceKind" AS ENUM ('TEMPLATE_BODY', 'FRAGMENT', 'PLATFORM', 'CONTRACT', 'LANGUAGE');

-- CreateEnum
CREATE TYPE "core"."GovernedPromptSourceType" AS ENUM ('PROMPT_VERSION', 'AGENT', 'PLATFORM');

-- CreateEnum
CREATE TYPE "core"."GovernedPromptVerdict" AS ENUM ('PASS', 'FAIL');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'GovernedPromptPiece';

-- CreateTable
CREATE TABLE "core"."GovernedPromptPiece" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "kind" "core"."GovernedPromptPieceKind" NOT NULL,
    "sourceType" "core"."GovernedPromptSourceType" NOT NULL,
    "sourceId" TEXT,
    "sourceKey" TEXT,
    "policyVersion" TEXT NOT NULL,
    "verdict" "core"."GovernedPromptVerdict" NOT NULL,
    "findings" JSONB,
    "textChars" INTEGER NOT NULL,
    "screenedAt" TIMESTAMP(3) NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernedPromptPiece_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GovernedPromptPiece_tenantId_idx" ON "core"."GovernedPromptPiece"("tenantId");

-- CreateIndex
CREATE INDEX "GovernedPromptPiece_digest_policyVersion_idx" ON "core"."GovernedPromptPiece"("digest", "policyVersion");

-- CreateIndex
CREATE INDEX "GovernedPromptPiece_source_idx" ON "core"."GovernedPromptPiece"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "GovernedPromptPiece_tenantId_digest_policyVersion_key" ON "core"."GovernedPromptPiece"("tenantId", "digest", "policyVersion");
