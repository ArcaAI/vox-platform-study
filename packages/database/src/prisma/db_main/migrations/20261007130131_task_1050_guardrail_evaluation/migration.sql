-- CreateEnum
CREATE TYPE "core"."GuardrailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "core"."GuardrailDecision" AS ENUM ('ALLOW', 'WARN', 'BLOCK', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "core"."GuardrailNoticeType" AS ENUM ('WARNING', 'BLOCKED', 'UNVERIFIED');

-- CreateEnum
CREATE TYPE "core"."GuardrailNoticeStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "core"."GuardrailItemStatus" AS ENUM ('CLEAN', 'WARNED', 'BLOCKED', 'WITHHELD');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "core"."ResourceType" ADD VALUE 'GuardrailEvaluation';
ALTER TYPE "core"."ResourceType" ADD VALUE 'GuardrailNotice';
ALTER TYPE "core"."ResourceType" ADD VALUE 'GuardrailPolicyRevision';

-- AlterTable
ALTER TABLE "core"."ContextItem" ADD COLUMN     "guardrailStatus" "core"."GuardrailItemStatus" NOT NULL DEFAULT 'CLEAN';

-- CreateTable
CREATE TABLE "core"."GuardrailEvaluation" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "consultationId" TEXT,
    "runId" TEXT,
    "runKey" TEXT,
    "nodeId" TEXT,
    "agentSlug" TEXT,
    "caller" TEXT NOT NULL,
    "direction" "core"."GuardrailDirection" NOT NULL,
    "decision" "core"."GuardrailDecision" NOT NULL,
    "exempt" TEXT,
    "checks" JSONB NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "noticeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encryptedWithheldContent" BYTEA,
    "keyVersion" INTEGER,
    "at" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GuardrailNotice" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT,
    "runId" TEXT,
    "nodeId" TEXT,
    "type" "core"."GuardrailNoticeType" NOT NULL,
    "direction" "core"."GuardrailDirection" NOT NULL,
    "action" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "itemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "messageKey" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "requiresAcknowledgement" BOOLEAN NOT NULL DEFAULT false,
    "resumable" BOOLEAN NOT NULL DEFAULT false,
    "policyVersion" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "core"."GuardrailNoticeStatus" NOT NULL DEFAULT 'OPEN',
    "acknowledgedBy" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedVia" TEXT,
    "resolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailNotice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GuardrailPolicyRevision" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aiModelId" TEXT NOT NULL,
    "policyKey" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "valueHash" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "restoredFromRevisionId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuardrailPolicyRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_tenant_consultation_at_idx" ON "core"."GuardrailEvaluation"("tenantId", "consultationId", "at");

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_tenant_at_idx" ON "core"."GuardrailEvaluation"("tenantId", "at");

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_runKey_idx" ON "core"."GuardrailEvaluation"("runKey");

-- CreateIndex
CREATE INDEX "GuardrailEvaluation_requestId_idx" ON "core"."GuardrailEvaluation"("requestId");

-- CreateIndex
CREATE INDEX "GuardrailNotice_tenant_consultation_status_idx" ON "core"."GuardrailNotice"("tenantId", "consultationId", "status");

-- CreateIndex
CREATE INDEX "GuardrailNotice_tenant_run_idx" ON "core"."GuardrailNotice"("tenantId", "runId");

-- CreateIndex
CREATE UNIQUE INDEX "GuardrailNotice_tenantId_dedupeKey_key" ON "core"."GuardrailNotice"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "GuardrailPolicyRevision_model_key_at_idx" ON "core"."GuardrailPolicyRevision"("aiModelId", "policyKey", "at");

-- CreateIndex
CREATE INDEX "GuardrailPolicyRevision_tenantId_idx" ON "core"."GuardrailPolicyRevision"("tenantId");
