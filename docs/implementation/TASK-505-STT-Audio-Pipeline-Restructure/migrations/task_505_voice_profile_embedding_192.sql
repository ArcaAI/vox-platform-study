-- TASK-505 Phase 4 (decision D1) — ECAPA-TDNN speaker-embedding cutover.
--
-- OPS ARTIFACT — deliberately NOT in packages/database/.../migrations:
-- changing the vector dimension voids stored embeddings (they are not
-- comparable across embedding models anyway), so this runs only when the
-- owner schedules voice-profile re-enrollment. Runbook:
--
--   0. Back up core."UserVoiceProfile" (rows are removed below — the column
--      is NOT NULL, so a dimension change cannot preserve them; embeddings
--      are model-bound and unusable after the model switch regardless).
--   1. Announce re-enrollment (existing voice profiles become void).
--   2. Apply this SQL via psql against the target DB (dev DBs in this repo
--      are `db push`-managed — apply here too, do NOT `migrate reset`).
--   3. Update packages/database/src/prisma/db_main/user.prisma:
--        embedding Unsupported("vector(256)") -> Unsupported("vector(192)")
--      and commit the schema change together with a proper migration copy of
--      this file (folder name task_505_voice_profile_embedding_192).
--   4. Flip stt-v2 settings:
--        DIARIZATION_HF_MODEL_ID=speechbrain/spkrec-ecapa-voxceleb
--        VOICE_PROFILE_EMBEDDING_DIM=192
--   5. Restart stt-v2; clinicians re-enroll (profiles are modelId-stamped,
--      so any stragglers restored from backup are detectable).
--
BEGIN;

-- Embeddings are model-specific and the column is NOT NULL: the dimension
-- change requires removing the rows (owner-approved, backed up in step 0).
DELETE FROM core."UserVoiceProfile";

-- Empty table — the type change needs no USING conversion.
ALTER TABLE core."UserVoiceProfile"
    ALTER COLUMN embedding TYPE vector(192);

COMMIT;
