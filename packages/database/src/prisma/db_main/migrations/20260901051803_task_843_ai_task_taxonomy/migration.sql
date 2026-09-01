-- CreateEnum
CREATE TYPE "core"."AiTaskKind" AS ENUM ('TEXT_GENERATION', 'TRANSLATION', 'SPEECH_TO_TEXT', 'TEXT_TO_SPEECH', 'VISION_EXTRACTION', 'EMBEDDING', 'NAMED_ENTITY_RECOGNITION', 'TEXT_CLASSIFICATION', 'CONTENT_SAFETY', 'GROUNDEDNESS', 'PII_DETECTION');

-- AlterTable
ALTER TABLE "core"."AiRoutingPolicy" ADD COLUMN     "taskKind" "core"."AiTaskKind";

-- AlterTable
ALTER TABLE "core"."AiTaskDefault" ADD COLUMN     "taskKind" "core"."AiTaskKind";

-- AlterTable
ALTER TABLE "core"."AsrPipeline" ADD COLUMN     "taskKind" "core"."AiTaskKind" NOT NULL DEFAULT 'SPEECH_TO_TEXT';

-- AlterTable
ALTER TABLE "core"."TenantSttConfig" ADD COLUMN     "taskKind" "core"."AiTaskKind" NOT NULL DEFAULT 'SPEECH_TO_TEXT';

-- AlterTable
ALTER TABLE "core"."TenantTtsConfig" ADD COLUMN     "taskKind" "core"."AiTaskKind" NOT NULL DEFAULT 'TEXT_TO_SPEECH';

-- CreateIndex
CREATE INDEX "AiRoutingPolicy_tenantId_taskKind_idx" ON "core"."AiRoutingPolicy"("tenantId", "taskKind");

-- CreateIndex
CREATE INDEX "AiTaskDefault_tenantId_taskKind_idx" ON "core"."AiTaskDefault"("tenantId", "taskKind");

-- ===========================================================================
-- TASK-843 BACKFILL — hand-written; everything above this line is Prisma's.
--
-- `AsrPipeline`, `TenantSttConfig` and `TenantTtsConfig` need NO data step:
-- their `taskKind` is constant for the table, so the NOT NULL DEFAULT above
-- already stamped every existing row with the correct value. That is also why
-- the same three tables stay correct under `db push`, which applies schema but
-- runs no migration body.
--
-- `AiTaskDefault` and `AiRoutingPolicy` DO need one, because their value is
-- DERIVED PER ROW from `taskKey`. The mapping below is the SQL twin of
-- `AI_TASK_KIND_BY_TASK_KEY`
-- (packages/applications/src/services/ai-task-default/constants.ts); the two
-- are kept in step by `ai-task-kind.test.ts`, which reads this file.
--
-- An UNRECOGNISED task key deliberately falls to NULL rather than to a
-- plausible guess. Selection is `failMode: closed` everywhere in this
-- platform (09-infrastructure-devops.md §Configuration Tiers), so "nobody
-- classified this" must stay distinguishable from "classified as X". The
-- assertion at the end is what makes that safe: it fails the migration if any
-- row carrying a KNOWN key was left behind.
--
-- Idempotent (`WHERE "taskKind" IS NULL`), so it is safe to re-run against an
-- environment whose schema arrived via `db push` instead of this ledger.
-- ===========================================================================

UPDATE "core"."AiTaskDefault"
SET "taskKind" = (
  CASE
    WHEN "taskKey" IN ('text.live', 'text.finalize', 'text.live.fallback', 'text.finalize.fallback', 'text.test', 'harness.judge') THEN 'TEXT_GENERATION'
    WHEN "taskKey" = 'vlm.extract' THEN 'VISION_EXTRACTION'
    WHEN "taskKey" = 'nlp.ner' THEN 'NAMED_ENTITY_RECOGNITION'
    WHEN "taskKey" IN ('nlp.classification', 'nlp.diagnosis', 'nlp.sentiment', 'nlp.toxicity', 'nlp.topic', 'nlp.intent') THEN 'TEXT_CLASSIFICATION'
    WHEN "taskKey" IN ('guardrail.validate', 'guardrail.safety') THEN 'CONTENT_SAFETY'
    WHEN "taskKey" = 'guardrail.groundedness' THEN 'GROUNDEDNESS'
    WHEN "taskKey" IN ('guardrail.pii', 'guardrail.pii.spans') THEN 'PII_DETECTION'
    ELSE NULL
  END
)::"core"."AiTaskKind"
WHERE "taskKind" IS NULL;

UPDATE "core"."AiRoutingPolicy"
SET "taskKind" = (
  CASE
    WHEN "taskKey" IN ('text.live', 'text.finalize', 'text.live.fallback', 'text.finalize.fallback', 'text.test', 'harness.judge') THEN 'TEXT_GENERATION'
    WHEN "taskKey" = 'vlm.extract' THEN 'VISION_EXTRACTION'
    WHEN "taskKey" = 'nlp.ner' THEN 'NAMED_ENTITY_RECOGNITION'
    WHEN "taskKey" IN ('nlp.classification', 'nlp.diagnosis', 'nlp.sentiment', 'nlp.toxicity', 'nlp.topic', 'nlp.intent') THEN 'TEXT_CLASSIFICATION'
    WHEN "taskKey" IN ('guardrail.validate', 'guardrail.safety') THEN 'CONTENT_SAFETY'
    WHEN "taskKey" = 'guardrail.groundedness' THEN 'GROUNDEDNESS'
    WHEN "taskKey" IN ('guardrail.pii', 'guardrail.pii.spans') THEN 'PII_DETECTION'
    ELSE NULL
  END
)::"core"."AiTaskKind"
WHERE "taskKind" IS NULL;

-- Assertion. A row whose `taskKey` is one this migration claims to know MUST
-- have come out non-NULL; if one did not, the CASE above and the task-key
-- vocabulary have drifted apart and the migration must not be recorded as
-- applied. Rows with an unknown key are permitted to stay NULL and are counted
-- into a NOTICE instead, so an operator sees them without the deploy failing.
DO $$
DECLARE
  unclassified_known INT;
  unclassified_other INT;
BEGIN
  SELECT count(*) INTO unclassified_known
  FROM (
    SELECT "taskKey", "taskKind" FROM "core"."AiTaskDefault"
    UNION ALL
    SELECT "taskKey", "taskKind" FROM "core"."AiRoutingPolicy"
  ) rows
  WHERE "taskKind" IS NULL
    AND "taskKey" IN (
      'text.live', 'text.finalize', 'text.live.fallback', 'text.finalize.fallback', 'text.test',
      'harness.judge', 'vlm.extract', 'nlp.ner', 'nlp.classification', 'nlp.diagnosis',
      'nlp.sentiment', 'nlp.toxicity', 'nlp.topic', 'nlp.intent', 'guardrail.validate',
      'guardrail.safety', 'guardrail.groundedness', 'guardrail.pii', 'guardrail.pii.spans'
    );

  IF unclassified_known > 0 THEN
    RAISE EXCEPTION 'TASK-843 backfill left % row(s) with a KNOWN taskKey unclassified', unclassified_known;
  END IF;

  SELECT count(*) INTO unclassified_other
  FROM (
    SELECT "taskKind" FROM "core"."AiTaskDefault"
    UNION ALL
    SELECT "taskKind" FROM "core"."AiRoutingPolicy"
  ) rows
  WHERE "taskKind" IS NULL;

  RAISE NOTICE 'TASK-843 backfill complete. % row(s) carry an unrecognised taskKey and were left NULL (fail-closed).', unclassified_other;
END $$;
