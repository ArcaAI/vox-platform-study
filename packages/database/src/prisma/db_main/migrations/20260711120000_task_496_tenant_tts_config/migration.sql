-- TASK-496 — Per-Tenant TTS Configuration
-- Additive only: two new tenant-scoped tables under the `core` schema. No data
-- is touched. TenantTtsConfig holds one row per tenant (SYSTEM tenant = platform
-- default); TenantTtsProviderCredential holds optional per-(tenant,provider)
-- bring-your-own API keys as Vault-Transit ciphertext (encryptedApiKey/keyVersion).

-- CreateTable
CREATE TABLE "core"."TenantTtsConfig" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "defaultVoiceEn" TEXT,
    "defaultVoiceMl" TEXT,
    "routingEn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "routingMl" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultFormat" TEXT,
    "defaultSpeed" DOUBLE PRECISION,
    "sampleRate" INTEGER,
    "maxInputChars" INTEGER,
    "sarvamPublicApiAllowed" BOOLEAN NOT NULL DEFAULT false,
    "configJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantTtsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantTtsProviderCredential" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT,
    "encryptedApiKey" BYTEA,
    "keyVersion" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantTtsProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantTtsConfig_tenantId_key" ON "core"."TenantTtsConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantTtsConfig_tenantId_idx" ON "core"."TenantTtsConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantTtsProviderCredential_tenantId_idx" ON "core"."TenantTtsProviderCredential"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantTtsProviderCredential_tenant_provider_unique" ON "core"."TenantTtsProviderCredential"("tenantId", "provider");

-- AlterEnum — audit ResourceType for TenantTtsConfig mutations (config + BYO
-- credentials both audited under this type). Idempotent (replay/shadow safe);
-- not used within this migration, so PG12+ ADD VALUE-in-transaction is fine.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantTtsConfig';
