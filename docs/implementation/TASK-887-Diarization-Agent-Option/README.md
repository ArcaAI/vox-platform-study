# TASK-887 — Diarization is a declared ASR-agent option

| | |
|---|---|
| **Status** | In Progress |
| **Type** | refactor / feature |
| **Program** | TASK-870 wave 3a, lane F (second batch — after TASK-880 merged) |
| **Branch** | `task-887-diarization-agent-option` → `dev-2.2` |
| **Base** | `1e81c4966` |

## Requirement Analysis

Owner decision, 2026-09-05 (TASK-870 target model item 8):

> The platform does NOT keep `stt.diarization.hfModelId` as "the" embedding space. The ASR
> agent node has an option for enabling diarization, OFF by default; the admin declares the
> embedding model(s) for diarization on the agent; when enabled, the logic diarizes
> automatically and labels the transcript either with generic labels (speaker 0, speaker 1, …)
> or with labelled embeddings — the enrolled voice profile of the end-user who is using the
> agent/workflow.

Consequence the decision forces: an enrolled profile is only meaningful **inside the vector
space of the model that produced it**, so the profile store is keyed by embedding model rather
than pinned to one platform-wide dimension.

Five deliverables:

1. The agent is the ONLY source of the embedding model. `stt.diarization.hfModelId` and
   `stt.voiceProfile.minSimilarity` are deleted end to end; `diarization.matchThreshold` joins
   the agent's diarization block. TASK-880's `globalOnly` keep and its
   `ASR_AGENT_EMBEDDING_SPACE_MISMATCH` 409 are removed (a mismatch is impossible by
   construction once profiles carry their own model), its slug-ref resolution stays.
2. Profiles live in the space of the model that embedded them: `UserVoiceProfile.modelId`
   becomes REQUIRED and holds the `AiModel` **slug**; `embedding` becomes dimension-agnostic
   `vector`.
3. Enrollment embeds with the model the agent declares (`agentSlug` optional on the enroll
   route; absent = the tenant's assigned ASR agent via the cascade).
4. Matching + labelling at diarization time is gateway-pushed: the session/job payload carries
   the end-user's active profiles for THAT model; `apps/stt` reads no voice-profile row.
5. Console + SDK expose the diarization block and carry `agentSlug` through enrollment.

Registry after: **2 keys fewer** (`stt.diarization.hfModelId`, `stt.voiceProfile.minSimilarity`).
`stt.diarization.device` stays — it is process placement, not selection.

## Current State Evaluation

Verified at `1e81c4966`.

| Fact | Where |
|---|---|
| The agent schema already carries `audioFrontEnd.diarization = { enabled, backend, embeddingModelSlug, maxSpeakers }` | `packages/workflow-contract/src/agent-schemas.ts` |
| `ASR_AUX_MODEL_PATHS` already maps `audioFrontEnd.diarization.embeddingModelSlug` → the `embedding` role | `agent-resolver.service.ts:30` |
| The SYSTEM ASR template seeds `diarization: { enabled: false }` and declares NO embedding model | `seed/25-agents.ts:105` |
| `stt.diarization.hfModelId` is read in three places | `voice_profile/extraction_service.py:113`, `diarization/embedding_service.py:123,291`, `core/config/settings.py:467` |
| `stt.voiceProfile.minSimilarity` is read once | `voice_profile/extraction_service.py:48` |
| `UserVoiceProfile.embedding` is `Unsupported("vector(256)")`, `modelId` is nullable | `user.prisma` |
| `preseed.py` reads `UserVoiceProfile` DIRECTLY from Postgres — forbidden on the agent path (rule 06) and dead today, because `STT_DATABASE_ENABLED` defaults `false` since TASK-861 | `diarization/preseed.py:80-125` → `core/database/voice_profile_model.py` |
| The STT extraction endpoint takes multipart `files` and NOTHING else; it picks the model from the platform singleton | `voice_profile/api/routes.py:33-41` |
| `SpeakerTracker.register(embedding, speaker_id=...)` already accepts a custom label; nothing marks a label as ENROLLED | `diarization/speaker_tracker.py:59` |
| The fixture agent binds `ecapa-tdnn-voxceleb` (192-d) with diarization ON, and its model row carries no `metaData`, so the TASK-880 mismatch guard never fires on it | `tests/contracts/resolved-asr-spec.fixture.json:47-51,137` |

## Implementation Plan

TDD per deliverable; gates listed at the end.

1. **Contract + agent schema.** `diarization.matchThreshold` on `AsrSpecAudioFrontEnd`
   (optional, omit-when-absent), on `spec.py`'s `AsrSpecDiarization`, on the agent JSON
   schema (default `0.6` = the retired platform default), in the fixture, and mapped onto
   `DiarizationConfig.match_threshold`. Builder: drop `assertEmbeddingSpace` /
   `VOICE_PROFILE_EMBEDDING_DIMENSION`; add the fail-closed refusal
   `ASR_AGENT_DIARIZATION_MODEL_MISSING` for `enabled && backend==='embedding'` with no bound
   embedding model.
2. **Key removals.** Both descriptors + the pinned test; `Settings.diarization_hf_model_id` /
   `voice_profile_min_similarity`; both `CONTROL_PLANE_KEYS` entries; the
   `get_embedding_service()` singleton and every fallback to it.
3. **Prisma / domain / seed.** `modelId` required, `embedding` → `vector`; entity, factory,
   mapper, model, DTOs; `seed/91-user.ts` writes the wespeaker SLUG. Migration SQL below.
4. **Enrollment.** `agentSlug` on the enroll request → `AsrAgentResolverService` → push
   `model_slug` / `model_source_uri` / `min_similarity` to STT; store `modelId = slug`.
5. **Matching + labelling.** `voice_profiles` on the session-create body and as a Dramatiq
   kwarg; `preseed.py` becomes pure; `voice_profile_model.py` deleted; the tracker learns
   which ids are ENROLLED and the identifier refuses to hand an enrolled label to a segment
   below `matchThreshold`.
6. **Console + SDK.**

### Intended migration SQL (the orchestrator authors the wave's single migration)

```sql
-- TASK-887 — a voice profile lives in the space of the model that embedded it.
-- 1. The column stops declaring one platform-wide width. pgvector accepts an
--    un-dimensioned `vector`; per-tenant profile sets are small (a handful of rows
--    per tenant), so brute-force cosine without an ANN index is the right trade —
--    and an unsized column cannot carry an ivfflat/hnsw index anyway.
ALTER TABLE core."UserVoiceProfile" ALTER COLUMN "embedding" TYPE vector;

-- 2. Backfill: every existing row was written by the platform singleton
--    (`stt.diarization.hfModelId` = pyannote/wespeaker-voxceleb-resnet34-LM), whose
--    registry row is `wespeaker-voxceleb-resnet34`. `modelId` held the HuggingFace id
--    (or NULL); it now holds the AiModel SLUG.
UPDATE core."UserVoiceProfile" SET "modelId" = 'wespeaker-voxceleb-resnet34' WHERE "modelId" IS NULL OR "modelId" <> 'wespeaker-voxceleb-resnet34';

-- 3. Only then may it be mandatory.
ALTER TABLE core."UserVoiceProfile" ALTER COLUMN "modelId" SET NOT NULL;
```

## Implementation Summary

_(filled in as the lane lands)_

## Handoffs

_(filled in as the lane lands)_

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Ticket opened; plan written against `1e81c4966`. |
