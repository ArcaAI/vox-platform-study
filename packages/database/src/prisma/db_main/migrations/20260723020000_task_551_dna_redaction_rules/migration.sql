-- DNA redaction/rewrite rules (encrypted at rest).
--
-- Adds the Vault-Transit (hope-phi) ciphertext column carrying each doctor's
-- structured redaction/rewrite rules to the DNA report and its version snapshot.
-- The rules are personal + PHI-adjacent, so they are persisted as ciphertext only
-- (encrypted-on-write via the same PHI-field helper as encryptedStyleText) — there
-- is NO plaintext counterpart column.
--
-- PURELY ADDITIVE. ADD COLUMN only. No DELETE / DROP / TRUNCATE.

ALTER TABLE "core"."DnaWritingStyleReport"
    ADD COLUMN "encryptedRedactionRules" BYTEA;

ALTER TABLE "core"."DnaWritingStyleVersion"
    ADD COLUMN "encryptedRedactionRules" BYTEA;

-- Tenant-level enablement gate for DNA redaction (max scope TENANT). Additive,
-- nullable — an unset value inherits (falls through the ConfigResolver cascade to
-- the code default OFF).
ALTER TABLE "core"."PipelinePolicy"
    ADD COLUMN "dnaRedactionEnabled" BOOLEAN;
