-- TASK-567 — Per-Tenant STT Fallback Configuration + BYOK
-- Additive only: two new tenant-scoped tables under the `core` schema plus two
-- new audit ResourceType enum members. No data is touched. TenantSttConfig holds
-- one row per tenant (SYSTEM tenant = platform default) carrying the fallback
-- pointer + auto-switch flag; TenantSttProviderCredential holds optional
-- per-(tenant,provider) bring-your-own API keys as Vault-Transit ciphertext
-- (encryptedApiKey/keyVersion). Mirrors TASK-496 (tenant TTS config).

-- CreateTable
CREATE TABLE "core"."TenantSttConfig" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fallbackPipelineId" TEXT,
    "autoSwitchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "configJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSttConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantSttProviderCredential" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT,
    "region" TEXT,
    "encryptedApiKey" BYTEA,
    "keyVersion" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "extraJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSttProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantSttConfig_tenantId_key" ON "core"."TenantSttConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantSttConfig_tenantId_idx" ON "core"."TenantSttConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantSttProviderCredential_tenantId_idx" ON "core"."TenantSttProviderCredential"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSttProviderCredential_tenant_provider_unique" ON "core"."TenantSttProviderCredential"("tenantId", "provider");

-- AlterEnum — audit ResourceType for TenantSttConfig mutations (config + BYO
-- credentials audited under these types). Idempotent (replay/shadow safe);
-- not used within this migration, so PG12+ ADD VALUE-in-transaction is fine.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantSttConfig';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantSttProviderCredential';
