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

All five deliverables landed. Registry **198 → 196** — `stt.diarization.hfModelId` and
`stt.voiceProfile.minSimilarity` are gone from the descriptor file, the `Settings` class, the
control-plane map and every reader; `stt.diarization.device` stays, because where a model runs
is a property of the box and not of the agent.

### The shape of the change

Before, the platform declared ONE embedding space: `stt.diarization.hfModelId` named the model,
`UserVoiceProfile.embedding` was `vector(256)` to match it, and TASK-880 had just added a 409
refusing any agent that bound a model of another width. Every one of those pieces existed to
defend a single global choice.

The owner's decision removes the choice, so the defences go with it. The agent names the model;
the profile records the model that embedded it; matching compares only profiles from that model.
A width mismatch is then impossible by construction rather than refused at resolve time, and the
column has no business declaring a dimension at all.

### Per deliverable

| # | What | Where | Reader replaced | Test that proves it |
|---|---|---|---|---|
| 1 | `matchThreshold` joins the agent's diarization block (default 0.6 — the retired key's value) | `agent-schemas.ts:279`, `asr-spec.ts:124`, `spec.py:203`, `dto.py:685`, fixture | — | `agent-schemas.task887.test.ts`, `test_task887_enrolled_labels.py::TestSpecMapping` |
| 1 | `stt.diarization.hfModelId` deleted | `stt-runtime.descriptors.ts:151`, `settings.py:466`, `control_plane.py:133` | `embedding_service.py:123` + `:291`, `extraction_service.py:113` | `stt-runtime.descriptors.test.ts` REMOVED_TASK_887, `test_settings.py::test_the_platform_embedding_model_and_similarity_floor_are_gone` |
| 1 | `stt.voiceProfile.minSimilarity` deleted | same three files | `extraction_service.py:48` | same two tests |
| 1 | `get_embedding_service()` singleton deleted | `embedding_service.py:286` | `session_manager.py:601,640`, `batch_service.py:389,790`, `inference.py:856`, `worker.py:105,149`, `main.py:195`, `voice_profile/api/routes.py:41` | `test_worker.py::test_boot_never_warms_a_diarization_embedding_model`, `test_inference_embedding_separation.py`, `test_diarization.py::test_the_model_id_is_required_not_defaulted` |
| 1 | TASK-880's `globalOnly` keep + `ASR_AGENT_EMBEDDING_SPACE_MISMATCH` removed; `ASR_AGENT_DIARIZATION_MODEL_MISSING` added (fail-closed selection) | `build-resolved-asr-spec.ts:225` | — | `build-resolved-asr-spec.test.ts` "the agent declares the diarization space" |
| 2 | `UserVoiceProfile.modelId` REQUIRED, holding the `AiModel` SLUG | `user.prisma:260`, entity, factory, model, `seed/91-user.ts:725` | — | `gen:model/entity/factory:check` (no drift, coverage OK) |
| 2 | `embedding` becomes dimension-agnostic `vector` | `user.prisma:257` | `EXPECTED_EMBEDDING_DIM` (`extraction_service.py:22`), the gateway's own 256 check (`voiceProfile.service.ts:25`) | `test_task799_env_surface.py::test_the_voice_profile_column_declares_no_dimension`, `test_asr_engines.py::TestP4EmbeddingDim` |
| 3 | `agentSlug` on enroll; the gateway resolves the agent and PUSHES its model | `enroll-body.dto.ts`, `voiceProfile.service.ts:45`, `voice_profile/api/routes.py:33` | — | `voiceProfile.service.test.ts` "the agent declares the embedding space" |
| 3 | `GET voice-profiles/enrollment-target` | `voice-profile.controller.ts:87` | — | `voiceProfile.service.test.ts::enrollmentTarget`, `constants.task265.test.ts` |
| 4 | Profiles resolved by the gateway and pushed on the session body / Dramatiq kwarg | `streamingSession.service.ts:150`, `transcriptionRealtime.service.ts:328`, `schemas.py:31`, `transcribe_file.py:56` | `preseed.py:80-125` → `core/database/voice_profile_model.py` (**deleted**) | `streamingSession.service.test.ts`, `transcriptionRealtime.service.test.ts`, `test_session_manager_preseed_tenant.py`, `test_preseed.py` |
| 4 | An ENROLLED label is never attached below `matchThreshold` | `speaker_tracker.py:59`, `speaker_identifier.py:52` | — | `test_task887_enrolled_labels.py::TestEnrolledLabelFloor` |
| 4 | The batch path resolves the embedding SLUG it had been dropping | `batch_service.py` `_embedding_model_id` | `batch_service.py:375` (INLINE-only) | `test_batch_service.py::TestRunDiarization` |
| 5 | Agent editor picks the embedding model from the `SPEAKER_EMBEDDING` catalogue | `parameters-form.tsx` `ModelSlugField` | free-text `ScalarField` | `parameters-form.test.tsx` "SPEECH_TO_TEXT diarization" |
| 5 | Playground flags a profile the assigned agent could never match | `voice-profiles-screen.tsx`, `profile-list-card.tsx` | — | `voice-profiles-screen.test.tsx` "re-enrollment prompt" |
| 5 | SDK: `enroll({ agentSlug })`, `enrollmentTarget()`, `needsReenrollment` | `useVoiceEmbedding.ts`, `useVoiceEnrollmentStatus.ts` | — | `useVoiceEmbedding.test.ts`, `useVoiceEnrollmentStatus.test.ts` |

### Decisions worth recording

- **`modelId` holds the `AiModel` SLUG**, not the row id and no longer the HuggingFace repo
  name. The slug is what the agent binds (`audioFrontEnd.diarization.embeddingModelSlug`) and
  what travels on the resolved spec (`models.embedding.slug`), so slug-to-slug is an exact
  comparison; `sourceUri` is not unique across rows (two rows may wrap one repo at different
  revisions or compute types) and the uuid never appears on the wire.
- **The profiles do NOT ride `ResolvedAsrSpec`.** The spec describes the AGENT and is fixture-
  pinned and user-independent; the profiles are per session/user. They travel beside it —
  `voice_profiles` on the session-create body and as a Dramatiq kwarg — the same way
  `provider_overrides` does, and are held in memory only (never persisted to Redis session
  metadata, never logged). A recovered session therefore loses its labels and diarizes
  generically rather than re-reading a vector from anywhere.
- **The model is a WHERE clause, not a post-filter.** `findActiveEmbeddingsForUser(userId,
  tenantId, modelId)` takes the model as a required argument, because "all of this user's
  profiles" is not a question that has a safe answer — comparing vectors across embedding
  spaces is meaningless, not merely inaccurate. `apps/stt` re-checks `model_id` on each pushed
  row anyway (defence in depth at the point of use).
- **No ANN index, deliberately.** pgvector cannot index an un-dimensioned column, and the
  candidate set is one user's handful of active profiles for one model — never a tenant-wide or
  corpus-wide search. Brute-force cosine is the right trade; the alternative is re-imposing the
  single platform space this ticket removed.
- **A new refusal replaces the removed one.** Embedding diarization ON with no model named is a
  409 (`ASR_AGENT_DIARIZATION_MODEL_MISSING`): model SELECTION fails closed (rule 09
  §Configuration Tiers), and silently diarizing without a model would drop every enrolled label
  without saying so. `backend: 'sortformer'` needs no embedding model and is untouched.
- **Generic labels keep their existing numbering** (`Speaker 1`, `Speaker 2`, …). The owner's
  "speaker 0, speaker 1, …" is illustrative; renumbering would churn `speaker-label.ts` and its
  consumers for nothing.
- **`ProfileListCard` flags any profile from another model, active or not.** The badge means
  "this agent cannot match this profile", which is true either way; the status line speaks only
  about the active set.

### Files changed, by package

| Package | Files |
|---|---|
| `packages/types` | `src/asr-spec.ts` |
| `packages/workflow-contract` | `src/agent-schemas.ts`, `src/__tests__/agent-schemas.task887.test.ts` (new) |
| `packages/database` | `src/prisma/db_main/user.prisma`, `seed/91-user.ts` |
| `packages/domains` | `UserVoiceProfile{Entity,Factory,Model,Repository}.ts` |
| `packages/applications` | `settings-registry/descriptors/stt-runtime.descriptors.ts` (+test), `stt/agent-resolver/build-resolved-asr-spec.ts` (+test), `stt/streaming/streamingSession.service{,.module}.ts` (+test), `stt/realtime/transcriptionRealtime.service{,.module}.ts` (+test), `user/voiceProfile/**` (service, interface, module, 2 DTOs, +test), `stt/__tests__/gateway-to-stt-internal-auth.test.ts` |
| `apps/api` | `modules/voice-profile/voice-profile.controller.ts`, `dto/{enroll-body,enrollment-target.response,index}.ts` |
| `apps/stt` | `core/config/settings.py`, `core/control_plane.py`, `core/database/voice_profile_model.py` (**deleted**), `diarization/{__init__,preseed,embedding_service,pyannote_embedding,speechbrain_embedding,speaker_tracker,speaker_identifier}.py`, `pipeline/{dto,spec}.py`, `streaming/{session_manager,inference,api/routes,api/schemas}.py`, `transcription/{batch_service,workers/transcribe_file}.py`, `main.py`, `worker.py`, `voice_profile/{extraction_service,api/routes,api/schemas}.py`, 12 test files (+2 new, 1 deleted) |
| `packages/agentic-sdk-v2` | `core/constants.ts`, `core.ts`, `hooks/{index,useVoiceEmbedding,useVoiceEnrollmentStatus}.ts` (+3 tests) |
| `apps/admin-console` | `features/agents/components/parameters-form.tsx` (+test), `features/playground-voice-profiles/api/{types,client,hooks,keys}.ts`, `components/{voice-profiles-screen,profile-list-card}.tsx` (+test) |
| `tests/contracts` | `resolved-asr-spec.fixture.json` |

### Deferred

- **The SYSTEM ASR template still declares no embedding model** (`seed/25-agents.ts:105` —
  lane-owned by neither this ticket nor lane B). Diarization is OFF there, so nothing is broken;
  but an admin who flips `enabled: true` without adding `embeddingModelSlug` now gets the 409.
  See handoff H-1.
- **`docs/operations/deprecation-register.md` is not updated.** Nothing here was deprecated —
  the two keys were REMOVED outright, which is what a pre-production removal looks like — but
  the register is a shared file the orchestrator may want to touch alongside the wave.

## Handoffs

Exact edits the orchestrator must apply in files this lane does not own.

### H-1 — `packages/database/src/prisma/db_main/seed/25-agents.ts` (unowned)

RECOMMENDED, not required. The SYSTEM ASR template seeds `diarization: { enabled: false }` and
names no model, so flipping diarization on is now a 409 until an `embeddingModelSlug` is added.
The 256-d wespeaker row is the model the seeded `UserVoiceProfile` rows were embedded with
(`seed/91-user.ts`), so it is the only value that makes the seeded profiles usable:

```ts
const ASR_PARAMETERS = {
  audioFrontEnd: {
    vad: { modelSlug: 'silero-vad', threshold: 0.5, minSpeechMs: 250, minSilenceMs: 500, speechPadMs: 200 },
    // TASK-887 — OFF by default (owner decision), but the space is declared so enabling it is
    // one flip rather than a 409 the admin has to decode.
    diarization: { enabled: false, backend: 'embedding', embeddingModelSlug: 'wespeaker-voxceleb-resnet34', maxSpeakers: 2, matchThreshold: 0.6 },
  },
  // …unchanged…
};
```

### H-2 — `packages/database/src/prisma/db_main/seed/ai-models/audio.ts` (lane B's file)

Two comments now describe a world that no longer exists. Both are documentation only.

- `:633` — the wespeaker row's `description` says *"the stt diarization feature-extractor
  default (diarization_hf_model_id)"*. There is no such key and no default; it is a
  `SPEAKER_EMBEDDING` row an agent may bind, like the ECAPA row beside it.
- `:648-655` and `:625-632` — the two `metaData.embedding.dimension` comments claim the width is
  "LOAD-BEARING" for `buildResolvedAsrSpec`'s refusal. That refusal is gone. **Keep the
  `metaData` itself** (it is honest catalogue metadata and `ai-model-registry-seed.test.ts:241`
  asserts it), but the comments should say it is descriptive.

### H-3 — the five-artifact regeneration (orchestrator-owned in 3a)

This lane changes the gateway's HTTP surface, so `api:route-manifest`, `api:openapi`,
`api:portal` and `gen:admin` are all stale until regenerated:

- **new route** `GET /api/v1/voice-profiles/enrollment-target` (`@Authorize(['read',
  'UserVoiceProfile'])`, on a `@ForbidApiKey()` controller);
- **changed request body** `POST /api/v1/voice-profiles/enroll` gains the optional multipart
  field `agentSlug`;
- `VoiceProfileEnrollmentTargetResponse` is a new response DTO.

The route is user-plane, not `admin/*`, so `gen:admin` should come out with zero diff — but it
is part of the same five-command block and must be run.

### H-4 — pre-existing reds this lane inherits (NOT caused here, NOT fixed here)

Both are consequences of the wave-3a batch-1 merge (`1e50834d7`, which applied TASK-880's H-1),
and both are in files this lane does not touch (`git diff --name-only 1e81c4966..HEAD` lists
none of them):

1. `azure-foundry` joined `CLOUD_BYO_PROVIDERS.stt` without the two tests that enumerate the
   resolved providers being updated — 3 failures in
   `packages/applications/.../asr-agent-resolver.service.test.ts` and 3 in
   `apps/api/src/modules/internal/__tests__/stt-internal.controller.test.ts`. Each expects a
   2- or 3-provider list and now receives one with `azure-foundry` in it.
2. The `tts.serviceToken` descriptor was deleted while four gateway readers of
   `TTS_SERVICE_TOKEN` remain (`agent.controller.ts:250`, `harness-tts-internal.controller.ts:242`,
   `speech-proxy.controller.ts:157`, `tts-ws.gateway.ts:309`), so
   `vault-kv-coverage.test.ts` reports 4 read-but-undeclared secrets.

## Change History

| Date | Change |
|---|---|
| 2026-09-06 | Ticket opened; plan written against `1e81c4966`. |
| 2026-09-06 | Contract + key removal: `matchThreshold` on the agent schema / `ResolvedAsrSpec` / `spec.py` / the fixture; `stt.diarization.hfModelId` + `stt.voiceProfile.minSimilarity` and the `get_embedding_service()` singleton removed end to end; TASK-880's space-mismatch 409 replaced by the fail-closed `ASR_AGENT_DIARIZATION_MODEL_MISSING`. |
| 2026-09-06 | Data + enrollment: `UserVoiceProfile.modelId` required (holding the `AiModel` slug), `embedding` dimension-agnostic; enrollment resolves the agent and pushes its model to `apps/stt`; `GET voice-profiles/enrollment-target`; session create and batch dispatch push the user's profiles for that model. |
| 2026-09-06 | Runtime labelling: `preseed.py` is pure and gateway-fed, `core/database/voice_profile_model.py` deleted, the tracker marks enrolled ids and the identifier refuses to attach an enrolled name below `matchThreshold`; the batch path resolves the embedding slug it had been dropping. |
| 2026-09-06 | Console + SDK: registry picker for `embeddingModelSlug` (driven by the schema's `modelTaskType` annotation), the playground's re-enrollment prompt, and `agentSlug` / `enrollmentTarget` / `needsReenrollment` on the SDK hooks. |
