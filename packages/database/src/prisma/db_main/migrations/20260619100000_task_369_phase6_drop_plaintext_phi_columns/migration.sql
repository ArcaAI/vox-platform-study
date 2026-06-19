-- TASK-369 (Data Encryption Initiative) Phase 6 — DROP the plaintext PHI columns.
--
-- All free-text clinical PHI is now persisted exclusively as Vault-Transit
-- ciphertext in the sibling `encrypted*` Bytes columns (written on every
-- create/update by the application services) and repopulated on read by the
-- base repository's decrypt-on-read. The dual-read soak that retained these
-- plaintext columns is complete, so they are dropped here.
--
-- SCOPE: 30 plaintext columns across 14 models + the now-unused
-- `NamedEntity_text_idx` (it indexed the dropped `text` column).
--
-- INTENTIONALLY RETAINED (NOT dropped):
--   * NamedEntity coded fields (umlsCui / snomedCode / rxnormCode / icdCode /
--     loincCode) and Notification.title — non-free-text, no `encrypted*`
--     counterpart.
--   * AuditLog.data / previousData — DEK-envelope encrypted (encryptedData /
--     encryptedPreviousData + dekWrapped) on a separate path; plaintext kept
--     for legacy rows.
--   * WORM payloads on HarnessAuditEvent / HarnessPolicyChange /
--     PipelinePolicyChange — append-only (UPDATE/DELETE revoked); their
--     `encrypted*` columns coexist with the immutable plaintext payloads.

-- DropIndex
DROP INDEX "core"."NamedEntity_text_idx";

-- AlterTable
ALTER TABLE "core"."ContextItem" DROP COLUMN "content";

-- AlterTable
ALTER TABLE "core"."ContextItemVersion" DROP COLUMN "changeSummary",
DROP COLUMN "content",
DROP COLUMN "contentDiff",
DROP COLUMN "fieldChanges";

-- AlterTable
ALTER TABLE "core"."DnaWritingStyleReport" DROP COLUMN "reportData",
DROP COLUMN "styleText";

-- AlterTable
ALTER TABLE "core"."DnaWritingStyleVersion" DROP COLUMN "reportData",
DROP COLUMN "styleText";

-- AlterTable
ALTER TABLE "core"."EvalRun" DROP COLUMN "notes";

-- AlterTable
ALTER TABLE "core"."EvalScore" DROP COLUMN "details",
DROP COLUMN "rationale";

-- AlterTable
ALTER TABLE "core"."GoldenCase" DROP COLUMN "referenceNote",
DROP COLUMN "transcript";

-- AlterTable
ALTER TABLE "core"."Highlight" DROP COLUMN "exact",
DROP COLUMN "note",
DROP COLUMN "prefix",
DROP COLUMN "suffix";

-- AlterTable
ALTER TABLE "core"."KnowledgeChunk" DROP COLUMN "text";

-- AlterTable
ALTER TABLE "core"."NamedEntity" DROP COLUMN "metadata",
DROP COLUMN "normalizedText",
DROP COLUMN "text";

-- AlterTable
ALTER TABLE "core"."Notification" DROP COLUMN "messageContent",
DROP COLUMN "messageRichText",
DROP COLUMN "messageText";

-- AlterTable
ALTER TABLE "core"."PromptTemplate" DROP COLUMN "lastTestOutput";

-- AlterTable
ALTER TABLE "core"."SummaryMeta" DROP COLUMN "citationsMap",
DROP COLUMN "guardrailDecisions";

-- AlterTable
ALTER TABLE "core"."TranscriptionJob" DROP COLUMN "resultMetadata",
DROP COLUMN "resultText";
