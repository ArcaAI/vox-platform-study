-- TASK-369 (Data Encryption Initiative) Phase 3C — roll the ContextItem.content
-- encryption recipe out to the remaining free-text clinical PHI fields.
--
-- For every encrypted field we add a nullable `encrypted<Field>` BYTEA column
-- holding the Vault-Transit (hope-phi) ciphertext; each model gets ONE shared
-- `keyVersion` INTEGER recording the Transit key version that produced the
-- row's ciphertext (forward-compat for key rotation / rewrap — the per-field
-- version is also recoverable from the `vault:vN:` ciphertext prefix).
--
-- Backward compatibility / dual-write soak:
--   - Every column is nullable; existing rows remain valid as-is.
--   - The plaintext columns stay in place for the one-release readback window
--     (reads decrypt only when encrypted<Field> IS NOT NULL, else fall back to
--     the plaintext column).
--   - Phase 6 will propose (under user gate) nulling + dropping plaintext for
--     migrated rows.
--
-- PURELY ADDITIVE. ADD COLUMN only. No DELETE / DROP / TRUNCATE.

-- ContextItemVersion (content / contentDiff / changeSummary / fieldChanges)
ALTER TABLE "core"."ContextItemVersion"
    ADD COLUMN "encryptedContent" BYTEA,
    ADD COLUMN "encryptedContentDiff" BYTEA,
    ADD COLUMN "encryptedChangeSummary" BYTEA,
    ADD COLUMN "encryptedFieldChanges" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- SummaryMeta (citationsMap / guardrailDecisions JSONB)
ALTER TABLE "core"."SummaryMeta"
    ADD COLUMN "encryptedCitationsMap" BYTEA,
    ADD COLUMN "encryptedGuardrailDecisions" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- NamedEntity (text / normalizedText / metadata JSONB)
ALTER TABLE "core"."NamedEntity"
    ADD COLUMN "encryptedText" BYTEA,
    ADD COLUMN "encryptedNormalizedText" BYTEA,
    ADD COLUMN "encryptedMetadata" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- Highlight (exact / prefix / suffix / note)
ALTER TABLE "core"."Highlight"
    ADD COLUMN "encryptedExact" BYTEA,
    ADD COLUMN "encryptedPrefix" BYTEA,
    ADD COLUMN "encryptedSuffix" BYTEA,
    ADD COLUMN "encryptedNote" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- TranscriptionJob (resultText / resultMetadata JSONB)
ALTER TABLE "core"."TranscriptionJob"
    ADD COLUMN "encryptedResultText" BYTEA,
    ADD COLUMN "encryptedResultMetadata" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- GoldenCase (transcript / referenceNote)
ALTER TABLE "core"."GoldenCase"
    ADD COLUMN "encryptedTranscript" BYTEA,
    ADD COLUMN "encryptedReferenceNote" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- EvalRun (notes)
ALTER TABLE "core"."EvalRun"
    ADD COLUMN "encryptedNotes" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- EvalScore (rationale / details JSONB)
ALTER TABLE "core"."EvalScore"
    ADD COLUMN "encryptedRationale" BYTEA,
    ADD COLUMN "encryptedDetails" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- DnaWritingStyleReport (reportData JSONB / styleText)
ALTER TABLE "core"."DnaWritingStyleReport"
    ADD COLUMN "encryptedReportData" BYTEA,
    ADD COLUMN "encryptedStyleText" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- DnaWritingStyleVersion (reportData JSONB / styleText)
ALTER TABLE "core"."DnaWritingStyleVersion"
    ADD COLUMN "encryptedReportData" BYTEA,
    ADD COLUMN "encryptedStyleText" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- KnowledgeChunk (text)
ALTER TABLE "core"."KnowledgeChunk"
    ADD COLUMN "encryptedText" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- Notification (messageText / messageRichText / messageContent JSONB)
ALTER TABLE "core"."Notification"
    ADD COLUMN "encryptedMessageText" BYTEA,
    ADD COLUMN "encryptedMessageRichText" BYTEA,
    ADD COLUMN "encryptedMessageContent" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;

-- PromptTemplate (lastTestOutput)
ALTER TABLE "core"."PromptTemplate"
    ADD COLUMN "encryptedLastTestOutput" BYTEA,
    ADD COLUMN "keyVersion" INTEGER;
