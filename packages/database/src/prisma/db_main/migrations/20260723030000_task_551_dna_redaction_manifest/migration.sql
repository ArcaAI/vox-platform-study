-- TASK-551 — DNA redaction/rewrite AUDIT TRAIL persisted on SummaryMeta.
--
-- The harness workflow computes a RedactionManifest (rule ids, actions, spans,
-- removed lengths — NEVER removed PHI plaintext) whenever the DNA redaction
-- transform runs. This persists that audit trail alongside the summary:
--   * `redactionApplied`           — plaintext, queryable marker (transform ran
--                                     AND changed the note).
--   * `encryptedRedactionManifest` — Vault-Transit (hope-phi) ciphertext of the
--                                     manifest detail, mirroring encryptedCitationsMap;
--                                     shares the existing `keyVersion` column.
--
-- PURELY ADDITIVE. ADD COLUMN only. No DELETE / DROP / TRUNCATE.

ALTER TABLE "core"."SummaryMeta"
    ADD COLUMN "redactionApplied" BOOLEAN;

ALTER TABLE "core"."SummaryMeta"
    ADD COLUMN "encryptedRedactionManifest" BYTEA;
