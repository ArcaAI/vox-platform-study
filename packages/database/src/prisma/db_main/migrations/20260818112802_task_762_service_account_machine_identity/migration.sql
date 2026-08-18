-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'ServiceAccount';

-- AlterTable
ALTER TABLE "core"."AuditLog" ADD COLUMN     "responsibleServiceAccountId" TEXT;

-- CreateTable
CREATE TABLE "core"."ServiceAccount" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "scopes" JSONB NOT NULL,
    "allowedTenantIds" JSONB,
    "allowedIps" JSONB,
    "superAdmin" BOOLEAN NOT NULL DEFAULT false,
    "tokenTtlSeconds" INTEGER NOT NULL DEFAULT 900,
    "lastUsedAt" TIMESTAMP(3),
    "credentialsRef" TEXT NOT NULL,
    "secretVerifier" TEXT NOT NULL,
    "previousCredentialsRef" TEXT,
    "previousSecretVerifier" TEXT,
    "previousCredentialExpiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_clientId_key" ON "core"."ServiceAccount"("clientId");

-- CreateIndex
CREATE INDEX "ServiceAccount_tenantId_idx" ON "core"."ServiceAccount"("tenantId");

-- CreateIndex
CREATE INDEX "ServiceAccount_clientId_idx" ON "core"."ServiceAccount"("clientId");

-- CreateIndex
CREATE INDEX "ServiceAccount_resourceStatus_idx" ON "core"."ServiceAccount"("resourceStatus");

-- CreateIndex
CREATE INDEX "ServiceAccount_lastUsedAt_idx" ON "core"."ServiceAccount"("lastUsedAt");

-- CreateIndex
CREATE INDEX "AuditLog_responsibleServiceAccountId_idx" ON "core"."AuditLog"("responsibleServiceAccountId");
