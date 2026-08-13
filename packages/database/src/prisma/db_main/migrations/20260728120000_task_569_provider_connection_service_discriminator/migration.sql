-- Unified Provider-Connection Plane (foundation)
--
-- ADDITIVE + REVERSIBLE. Adds the `service` discriminator to
-- "core"."AiProviderConnection", re-keys it on (tenantId, service, provider),
-- rebuilds indexes, and COPIES (never moves) the legacy per-capability
-- credential rows into the unified table. The legacy tables
-- ("TenantTtsProviderCredential" / "TenantSttProviderCredential") are left
-- INTACT — drops them once every gateway has repointed.
--
-- Idempotent: the ADD COLUMN uses IF NOT EXISTS via a guarded block, the index
-- swaps use IF [NOT] EXISTS, and the data copies use ON CONFLICT DO NOTHING, so
-- a re-run neither errors nor clobbers an already-present row.
--
-- Requires PostgreSQL 18 (native `uuidv7()`), the platform baseline.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Add the `service` discriminator. NOT NULL DEFAULT 'llm' backfills every
--    existing row to the LLM capability (R5) in the same statement.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE "core"."AiProviderConnection"
  ADD COLUMN IF NOT EXISTS "service" TEXT NOT NULL DEFAULT 'llm';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Re-key: drop the old (tenantId, provider) unique, add the
--    (tenantId, service, provider) unique. Existing rows are all service='llm',
--    so the new unique is a strict superset — no row can violate it.
-- ────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "core"."AiProviderConnection_tenant_provider_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "AiProviderConnection_tenant_service_provider_unique"
  ON "core"."AiProviderConnection"("tenantId", "service", "provider");

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Rebuild the lookup indexes: the tenant index gains `service`; add a
--    (service, provider) index. The standalone (provider) index is retained.
-- ────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "core"."AiProviderConnection_tenantId_idx";
CREATE INDEX IF NOT EXISTS "AiProviderConnection_tenantId_service_idx"
  ON "core"."AiProviderConnection"("tenantId", "service");
CREATE INDEX IF NOT EXISTS "AiProviderConnection_service_provider_idx"
  ON "core"."AiProviderConnection"("service", "provider");

-- ────────────────────────────────────────────────────────────────────────────
-- 4a. COPY the TTS credential rows → service='tts'. `endpoint` maps to
--     `baseUrl`; ciphertext/keyVersion/enabled/status/audit are preserved.
--     Fresh uuid7 id + _version=1 (a new row identity in the unified table).
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO "core"."AiProviderConnection" (
  "id", "_version", "_metadata", "tenantId", "service", "provider",
  "baseUrl", "region", "apiVersion", "deploymentName",
  "encryptedApiKey", "keyVersion", "enabled",
  "resourceStatus", "resourceStatusUpdatedAt", "resourceStatusUpdatedBy",
  "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  uuidv7(), 1, src."_metadata", src."tenantId", 'tts', src."provider",
  src."endpoint", NULL, NULL, NULL,
  src."encryptedApiKey", src."keyVersion", src."enabled",
  src."resourceStatus", src."resourceStatusUpdatedAt", src."resourceStatusUpdatedBy",
  src."createdBy", src."updatedBy", src."createdAt", src."updatedAt"
FROM "core"."TenantTtsProviderCredential" AS src
ON CONFLICT ("tenantId", "service", "provider") DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 4b. COPY the STT credential rows → service='stt'. `endpoint`→`baseUrl`,
--     `region`→`region`, `extraJson`→`extraJson`; ciphertext/keyVersion/enabled/
--     status/audit preserved. Fresh uuid7 id + _version=1.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO "core"."AiProviderConnection" (
  "id", "_version", "_metadata", "tenantId", "service", "provider",
  "baseUrl", "region", "apiVersion", "deploymentName",
  "encryptedApiKey", "keyVersion", "enabled", "extraJson",
  "resourceStatus", "resourceStatusUpdatedAt", "resourceStatusUpdatedBy",
  "createdBy", "updatedBy", "createdAt", "updatedAt"
)
SELECT
  uuidv7(), 1, src."_metadata", src."tenantId", 'stt', src."provider",
  src."endpoint", src."region", NULL, NULL,
  src."encryptedApiKey", src."keyVersion", src."enabled", src."extraJson",
  src."resourceStatus", src."resourceStatusUpdatedAt", src."resourceStatusUpdatedBy",
  src."createdBy", src."updatedBy", src."createdAt", src."updatedAt"
FROM "core"."TenantSttProviderCredential" AS src
ON CONFLICT ("tenantId", "service", "provider") DO NOTHING;
