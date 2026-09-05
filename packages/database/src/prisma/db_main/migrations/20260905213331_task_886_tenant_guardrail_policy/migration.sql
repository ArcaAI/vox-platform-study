-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'TenantGuardrailPolicy';

-- CreateTable
CREATE TABLE "core"."TenantGuardrailPolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policies" JSONB NOT NULL,
    "reason" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantGuardrailPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantGuardrailPolicy_tenantId_key" ON "core"."TenantGuardrailPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "TenantGuardrailPolicy_tenantId_idx" ON "core"."TenantGuardrailPolicy"("tenantId");
