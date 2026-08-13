-- Config-plane core: AiProviderConnection + AiRuntimeProfile.
--
-- Purely ADDITIVE: two new tables, no changes to any existing column or row.
--
--   AiProviderConnection — WHERE a serving provider lives and HOW to
--   authenticate. One row per (tenant, provider); the SYSTEM-tenant row is the
--   platform default. Generalizes TenantTtsProviderCredential to all LLM
--   providers. `encryptedApiKey` is Vault-Transit ciphertext (BYTEA) — plaintext
--   is never stored and no read DTO ever returns it.
--
--   AiRuntimeProfile — hyperparameters / context / concurrency per provider
--   (`modelSlug = ''`) or per model (`modelSlug = AiModel.slug`). The
--   empty-string sentinel is deliberate: Postgres treats NULLs as DISTINCT in
--   unique indexes, so a nullable `modelSlug` would permit duplicate
--   provider-default rows and break compound-unique upserts.
--
-- Both tables carry the house field template (`_metadata`, `_version`, uuid(7)
-- id, tenantId, resource-status block, audit block) and are soft-deleting, so
-- neither belongs in MODELS_WITHOUT_SOFT_DELETE. Both are registered in
-- TENANT_SCOPED_MODELS and SYSTEM_SHARED_READ_MODELS.
--
-- Additive + idempotent so it is safe to apply via `pnpm db:push` / psql on the
-- db-push-managed dev database (every CREATE is guarded).

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."AiProviderConnection" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "region" TEXT,
    "apiVersion" TEXT,
    "deploymentName" TEXT,
    "encryptedApiKey" BYTEA,
    "keyVersion" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "extraJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AiProviderConnection_tenant_provider_unique" ON "core"."AiProviderConnection"("tenantId", "provider");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiProviderConnection_tenantId_idx" ON "core"."AiProviderConnection"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiProviderConnection_provider_idx" ON "core"."AiProviderConnection"("provider");

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."AiRuntimeProfile" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL DEFAULT '',
    "temperature" DOUBLE PRECISION,
    "topP" DOUBLE PRECISION,
    "maxTokens" INTEGER,
    "contextLength" INTEGER,
    "maxConcurrent" INTEGER,
    "tpmLimit" INTEGER,
    "rpmLimit" INTEGER,
    "timeoutS" INTEGER,
    "keepAliveSeconds" INTEGER,
    "extraJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRuntimeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AiRuntimeProfile_tenant_provider_model_unique" ON "core"."AiRuntimeProfile"("tenantId", "provider", "modelSlug");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiRuntimeProfile_tenantId_idx" ON "core"."AiRuntimeProfile"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiRuntimeProfile_provider_idx" ON "core"."AiRuntimeProfile"("provider");

-- ─────────────────────────────────────────────────────────────────────────────
-- Audit ResourceType enum values for the two new resources.
--
-- Both services emit `broadcastSysEvent(...)` on every mutation, which writes an
-- AuditLog row carrying `resourceType`. Without these values that INSERT throws
-- ("Invalid value for argument `resourceType`") and rolls the originating
-- mutation back into a 500 — the failure mode the enum-parity guard
-- (`resourceType.enum-parity.test.ts`) exists to prevent.
--
-- Append-only ADD VALUE, guarded so re-application is a no-op.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'AiProviderConnection';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'AiRuntimeProfile';
