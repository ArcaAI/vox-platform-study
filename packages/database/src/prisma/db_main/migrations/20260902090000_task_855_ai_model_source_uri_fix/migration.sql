-- ============================================================================
-- TASK-855 — Model Weights From Object Storage (lane L2: registry backfill).
--
-- Pure DATA migration — no schema change. Corrects two `sourceUri` values
-- verified WRONG against the HuggingFace API on 2026-09-02: the real repos
-- carry a dot in the date segment ("2607.26"), the seeded rows read the
-- undotted "260726".
--
-- `localPath` is deliberately NOT touched by this migration. `AiModel.
-- localPath` already exists (added by 20260817000000_init) and every
-- model-hosting service already reads it as the highest-precedence override
-- in `resolve_model_dir` (stt, guardrail, nlp, harness) — but the value is
-- CONTENT-DERIVED (`<quant>-<first 12 of sha256(SHA256SUMS)>`, produced by
-- the `hope-models-publish` Job) and cannot be known before a model is
-- actually published to the `hope-models` bucket. Neither row corrected here
-- is in the bucket yet. The Phase 2 download action is specified to write
-- `localPath` back automatically, alongside `downloadStatus`/`checksum`, once
-- a model is actually fetched — a migration must not fabricate it ahead of
-- that. (An earlier revision of this migration DID set `localPath` for two
-- rows verified present in a local lab bucket, conflating it with the real
-- dev bucket; that revision was replaced by this one before being applied
-- anywhere.)
--
-- Matches by `slug`, not `id`: `backfillCustomerTenantAiModels`
-- (seed/06-stt.ts) clones every SYSTEM catalogue row into each seeded
-- customer tenant with a FRESH id but the SAME slug, so a slug match sweeps
-- every tenant's copy in one statement — the same pattern
-- `retireLegacyAiModels` in the same file already uses for its own sweep.
--
-- Guarded for idempotency and to never clobber a value an operator already
-- customised: each `sourceUri` fix only fires where the column still holds
-- the exact known-wrong value.
-- ============================================================================

-- Corrected sourceUri (whisper.cpp GGUF build) — dotted date segment.
UPDATE "core"."AiModel"
SET "sourceUri" = 'taphuynh/whisper-large-en-medical-2607.26-merged-gguf'
WHERE "slug" = 'whisper-large-en-medical-260726-merged-gguf'
  AND "sourceUri" = 'taphuynh/whisper-large-en-medical-260726-merged-gguf';

-- Corrected sourceUri (CTranslate2 build) — dotted date segment.
UPDATE "core"."AiModel"
SET "sourceUri" = 'taphuynh/whisper-large-en-medical-2607.26-merged-ct2'
WHERE "slug" = 'whisper-large-en-medical-260726-merged-ct2'
  AND "sourceUri" = 'taphuynh/whisper-large-en-medical-260726-merged-ct2';
