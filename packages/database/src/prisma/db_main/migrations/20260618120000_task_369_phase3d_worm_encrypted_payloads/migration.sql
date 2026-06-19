-- TASK-369 (Data Encryption Initiative) Phase 3D — WORM / hash-chained tables.
--
-- Encrypt-before-hash for the append-only WORM audit/policy-change tables. For
-- every encrypted JSON payload we add a nullable `encrypted<Field>` BYTEA column
-- holding the Vault-Transit (hope-phi) ciphertext, plus ONE shared `keyVersion`
-- INTEGER recording the Transit key version that produced the row's ciphertext
-- (forward-compat for rotation; also recoverable from the `vault:vN:` prefix).
--
-- NEW-ROWS-ONLY (no backfill): these tables `REVOKE UPDATE, DELETE` so rows are
-- immutable. Only newly-appended rows are encrypted — the writer puts ciphertext
-- in the new columns, derives the integrity `hash` over that CIPHERTEXT, and
-- writes a non-PHI redaction sentinel ({"_encrypted": true}) into the plaintext
-- JSONB columns. Historical rows are NEVER rewritten: they keep plaintext, have
-- NULL encrypted* columns, hash over plaintext, and stay protected by Phase 1
-- disk encryption.
--
-- PURELY ADDITIVE. ADD COLUMN only. No DELETE / DROP / TRUNCATE. (No GRANT/REVOKE
-- change needed: ADD COLUMN does not require UPDATE/DELETE on the WORM tables.)

-- HarnessAuditEvent (sensorScores / citations JSONB — hash-chained)
ALTER TABLE "core"."HarnessAuditEvent"
    ADD COLUMN "encryptedSensorScores" BYTEA,
    ADD COLUMN "encryptedCitations" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- HarnessPolicyChange (beforeJson / afterJson JSONB)
ALTER TABLE "core"."HarnessPolicyChange"
    ADD COLUMN "encryptedBeforeJson" BYTEA,
    ADD COLUMN "encryptedAfterJson" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- PipelinePolicyChange (beforeJson / afterJson JSONB)
ALTER TABLE "core"."PipelinePolicyChange"
    ADD COLUMN "encryptedBeforeJson" BYTEA,
    ADD COLUMN "encryptedAfterJson" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;
