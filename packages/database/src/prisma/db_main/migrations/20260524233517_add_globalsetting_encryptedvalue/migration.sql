-- TASK-302 Phase 4 Task 4.2 — additive schema migration for Vault-Transit
-- envelope encryption of GlobalSetting rows. Adds two nullable columns:
--   encryptedValue (BYTEA) — Vault-Transit-encrypted ciphertext blob.
--   keyVersion     (INTEGER) — Transit key version that produced the
--                              ciphertext (forward-compat for key rotation).
--
-- Backward compatibility:
--   - Both columns are nullable; existing rows remain valid as-is.
--   - The plaintext `value` column stays in place for one release as the
--     readback fallback (Phase 4C decrypts only when encryptedValue IS NOT NULL).
--   - Phase 4D will propose (under user gate) the removal of plaintext rows
--     for migrated secrets.
--
-- Backward-compatible: ADD COLUMN is additive. No DELETE/DROP/TRUNCATE.

-- AlterTable
ALTER TABLE "core"."GlobalSetting"
    ADD COLUMN "encryptedValue" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;
