-- ============================================================================
-- TASK-858 D5 — repoint the SYSTEM text-generation task defaults to
-- `lms-gemma-4-e4b-it-qat` (LM Studio wire id `gemma-4-e4b-it-qat`, the QAT
-- build of `google/gemma-4-E4B-it-qat-q4_0-gguf`).
--
-- Pure DATA migration — no schema change.
--
-- WHY IT EXISTS. `seedAiTaskDefault` (seed/16-ai-task-default.ts) is
-- CREATE-ONLY by design: the platform default is admin-tunable at runtime and
-- a re-seed must never clobber an operator's choice. That is correct, and it
-- is exactly why the seed edit alone reaches only a COLD database. Every
-- database seeded before 2026-09-03 keeps the old rows forever unless
-- something moves them, and this file is that something.
--
-- WHY IT IS GUARDED. The same reason the seed is create-only: an operator may
-- already have repointed one of these keys deliberately. So each statement
-- fires ONLY where the row still holds the exact value the seed wrote —
-- `lms-gemma-4-e2b-it-qat` for the three `text.*` keys, `lms-gemma-4-e4b` for
-- `harness.judge`. Anything else is somebody's decision and is left alone.
--
-- SYSTEM TENANT ONLY (`00000000-…`). A tenant's own `text.*` row is that
-- tenant's opinion and outranks the platform default; rewriting it here would
-- invert the tenant -> SYSTEM cascade this platform is built on.
--
-- Idempotent: a second run matches nothing, because the guard value is gone.
-- ============================================================================

-- The three `text.*` keys: live (partial summaries + the realtime grammar
-- pass), finalize (the clinical note), test (the prompt-template Test button).
UPDATE "core"."AiTaskDefault"
SET "modelSlug" = 'lms-gemma-4-e4b-it-qat',
    "_version" = "_version" + 1,
    "updatedAt" = NOW()
WHERE "tenantId" = '00000000-0000-0000-0000-000000000000'
  AND "taskKey" IN ('text.live', 'text.finalize', 'text.test')
  AND "modelSlug" = 'lms-gemma-4-e2b-it-qat';

-- The LLM-as-judge selection. Its previous value is a DIFFERENT slug from the
-- three above (`lms-gemma-4-e4b`, the un-quantized `google/gemma-4-e4b`), so
-- it needs its own guard rather than sharing the statement.
UPDATE "core"."AiTaskDefault"
SET "modelSlug" = 'lms-gemma-4-e4b-it-qat',
    "_version" = "_version" + 1,
    "updatedAt" = NOW()
WHERE "tenantId" = '00000000-0000-0000-0000-000000000000'
  AND "taskKey" = 'harness.judge'
  AND "modelSlug" = 'lms-gemma-4-e4b';
