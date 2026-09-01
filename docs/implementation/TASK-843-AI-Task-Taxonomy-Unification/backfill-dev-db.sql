-- ===========================================================================
-- TASK-843 — standalone, idempotent backfill for the `db push`-managed dev DB.
--
-- WHY THIS FILE EXISTS
-- The local dev database has NO `_prisma_migrations` ledger, so it is synced
-- with `pnpm db:push`, which applies SCHEMA but runs no migration BODY. The
-- three constant-kind tables (AsrPipeline, TenantSttConfig, TenantTtsConfig)
-- come out correct anyway — their column carries a NOT NULL DEFAULT that
-- `db push` stamps onto every existing row. `AiTaskDefault` and
-- `AiRoutingPolicy` do NOT: their `taskKind` is derived per row from `taskKey`,
-- so on the dev DB they land NULL and need this one statement pair.
--
-- It is byte-for-byte the backfill half of
-- `packages/database/src/prisma/db_main/migrations/20260901051803_task_843_ai_task_taxonomy/migration.sql`
-- and is pinned against the TypeScript mapping by
-- `packages/applications/src/services/ai-task-default/__tests__/ai-task-kind.test.ts`.
--
-- It lives HERE, not under `migrations/`, deliberately: Prisma applies EVERY
-- subdirectory of `migrations/` that contains a `migration.sql` regardless of
-- its name, so a "for the operator to run" folder there would reach CI and the
-- k3s PreSync job too (`.claude/rules/02-database-prisma.md`).
--
-- HOW TO RUN (orchestrator, after `pnpm db:push`):
--   docker exec -i hope-postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f - < this-file
--
-- Idempotent (`WHERE "taskKind" IS NULL`) — safe to run more than once, and a
-- no-op on any environment that received the migration through the ledger.
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

-- Report, so the operator sees the outcome rather than assuming it.
SELECT 'AiTaskDefault'   AS "table", count(*) AS total, count("taskKind") AS classified, count(*) - count("taskKind") AS unclassified FROM "core"."AiTaskDefault"
UNION ALL SELECT 'AiRoutingPolicy', count(*), count("taskKind"), count(*) - count("taskKind") FROM "core"."AiRoutingPolicy"
UNION ALL SELECT 'AsrPipeline',     count(*), count("taskKind"), count(*) - count("taskKind") FROM "core"."AsrPipeline"
UNION ALL SELECT 'TenantSttConfig', count(*), count("taskKind"), count(*) - count("taskKind") FROM "core"."TenantSttConfig"
UNION ALL SELECT 'TenantTtsConfig', count(*), count("taskKind"), count(*) - count("taskKind") FROM "core"."TenantTtsConfig"
ORDER BY 1;
