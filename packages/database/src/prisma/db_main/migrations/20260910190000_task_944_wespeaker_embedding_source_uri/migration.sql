-- ============================================================================
-- TASK-944 B2 — the built-in speaker-embedding row must name the repo that is
-- actually PUBLISHED.
--
-- Pure DATA migration — no schema change. Same shape, and the same reasoning,
-- as 20260902090000_task_855_ai_model_source_uri_fix.
--
-- WHY THIS EXISTS AT ALL. `seed/ai-models/audio.ts` has always declared
-- `sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM'` for this slug, and
-- `seedAiModels` re-syncs that column on every re-seed. But the deployed
-- database is already seeded and the k3s `hope-db-migrate` Job runs with
-- `RUN_SEED=none`, so a seed CORRECTION never reaches it. `migrate deploy` is
-- the only path that does. This migration is therefore the re-seed of exactly
-- one column of exactly one row — it can clobber nothing that a re-seed would
-- have preserved.
--
-- WHAT WENT WRONG. Measured in-pod on `hope-v2-dev` (pipeline #1169,
-- 2026-09-10): `HF_HOME=/mnt/models-bucket/hf`,
-- `HF_HUB_CACHE=/mnt/models-bucket/hf/hub`, `HF_HUB_OFFLINE=1` and the weights
-- present at `/mnt/models-bucket/hf/hub/models--pyannote--wespeaker-voxceleb-resnet34-LM`
-- — yet the streaming warm spent ~16.6 s failing to load the embedding model,
-- because the identifier the loader was handed matched neither the Hub nor that
-- cached directory. `AiModel.sourceUri` is the ONE place that identifier comes
-- from: it is forwarded verbatim through `ResolvedAgentModel.sourceUri` ->
-- `AsrSpecModel.sourceUri` -> `AiModelConfig.source_uri` ->
-- `resolve_weights_or_hf_id`, with no code default anywhere on the path. The
-- repo id is DATA on the row, and a slug -> repo map inside a loader would be
-- the hardcoded configuration `09-infrastructure-devops.md` forbids.
--
-- Matches by `slug`, not `id`, and does not filter on `tenantId`: older seeds
-- cloned SYSTEM catalogue rows into customer tenants with a FRESH id and the
-- SAME slug, so a slug match sweeps every surviving copy in one statement —
-- the pattern `retireLegacyAiModels` and task_855 both already use.
--
-- Guarded with `IS DISTINCT FROM` so the statement is a no-op once the value is
-- right: re-running it (as a hand repair, or against a freshly seeded database)
-- touches no row.
-- ============================================================================

UPDATE "core"."AiModel"
SET "sourceUri" = 'pyannote/wespeaker-voxceleb-resnet34-LM'
WHERE "slug" = 'wespeaker-voxceleb-resnet34'
  AND "sourceUri" IS DISTINCT FROM 'pyannote/wespeaker-voxceleb-resnet34-LM';
