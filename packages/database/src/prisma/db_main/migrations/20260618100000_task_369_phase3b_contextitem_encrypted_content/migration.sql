-- TASK-369 (Data Encryption Initiative) Phase 3B — pilot field encryption on
-- ContextItem.content (highest-volume free-text clinical PHI).
--
-- Adds two nullable columns mirroring the GlobalSetting recipe:
--   encryptedContent  (BYTEA)   — Vault-Transit (hope-phi) encrypted ciphertext of `content`.
--   contentKeyVersion (INTEGER) — Transit key version that produced the ciphertext
--                                 (forward-compat for key rotation / rewrap).
--
-- Backward compatibility / dual-write soak:
--   - Both columns are nullable; existing rows remain valid as-is.
--   - The plaintext `content` column stays in place for the one-release readback
--     window (reads decrypt only when encryptedContent IS NOT NULL, else fall
--     back to plaintext).
--   - Phase 6 will propose (under user gate) nulling + dropping plaintext for
--     migrated rows.
--
-- PURELY ADDITIVE. ADD COLUMN only. No DELETE / DROP / TRUNCATE.

-- AlterTable
ALTER TABLE "core"."ContextItem"
    ADD COLUMN "encryptedContent" BYTEA,
    ADD COLUMN "contentKeyVersion" INTEGER;
