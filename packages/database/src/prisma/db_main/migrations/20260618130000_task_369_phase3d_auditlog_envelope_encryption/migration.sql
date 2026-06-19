-- TASK-369 (Data Encryption Initiative) Phase 3D — AuditLog envelope encryption.
--
-- AuditLog is the highest-volume write path, so a Vault Transit round-trip PER
-- ROW is too costly. Approach = ENVELOPE ENCRYPTION with a cached Data Encryption
-- Key (DEK): a DEK is generated once per process and wrapped ONCE via Vault
-- Transit (hope-phi); each row's `data`/`previousData` is then encrypted LOCALLY
-- with authenticated AES-256-GCM into the new BYTEA columns (zero Vault calls on
-- the hot path). The wrapped DEK + its Transit key version are persisted per row
-- so rows stay decryptable after key rotation.
--
-- Dual-read soak: the plaintext JSONB columns are RETAINED; reads decrypt only
-- when `encryptedData IS NOT NULL`, else fall back to plaintext. Phase 6 will
-- propose (under user gate) nulling + dropping the plaintext for migrated rows.
-- `metadata` stays plaintext (non-PHI: ids/flags).
--
-- PURELY ADDITIVE. ADD COLUMN only. No DELETE / DROP / TRUNCATE.

ALTER TABLE "core"."AuditLog"
    ADD COLUMN "encryptedData" BYTEA,
    ADD COLUMN "encryptedPreviousData" BYTEA,
    ADD COLUMN "dekWrapped" TEXT,
    ADD COLUMN "dekKeyVersion" INTEGER;
