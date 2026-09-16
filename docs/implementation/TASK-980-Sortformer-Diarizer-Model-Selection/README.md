# TASK-980 — Sortformer diarization selects its model through the registry, not a literal

| | |
|---|---|
| **Status** | Pending — awaiting owner decisions (below) |
| **Type** | refactor / feature |
| **Base** | `9c7b61a75` |
| **Origin** | Flagged by TASK-977 (README "Still owed"); design investigated 2026-09-16 |

## Requirement Analysis

An ASR agent's diarization block declares `backend: 'embedding' | 'sortformer'`. The `embedding` backend
is fully agent-driven since TASK-887: the agent names `embeddingModelSlug`, the gateway resolves it through
the tenant → SYSTEM registry cascade, and the resolver refuses an enabled stage with no model (409
`ASR_AGENT_DIARIZATION_MODEL_MISSING`). The `sortformer` backend has none of that: its checkpoint, revision,
threshold and frame shift are Python literals, so no agent can choose, pin, veto or tenant-scope the model.
That breaks two owner rules — **no hardcoded configuration**, and **model selection fails closed**.

The literal is not arbitrary: `apps/stt/src/stt/pipeline/dto.py:704-708` records an **owner directive of
2026-07-11** pinning `nvidia/diar_streaming_sortformer_4spk-v2.1` under the NVIDIA Open Model License
(commercial use permitted, owner-accepted). Any fix must carry that decision into the registry row.

## Current State Evaluation

Verified 2026-09-16 (orchestrator re-checked the starred rows directly).

| Fact | Where |
|---|---|
| ★ Checkpoint, revision (`None`), threshold (0.5), frame shift (0.08) are dataclass literals | `apps/stt/src/stt/pipeline/dto.py:703-714` |
| Same literals repeated in the deprecated YAML parser; a second `0.5` fallback in inference | `yaml_parser.py:756-763`, `streaming/inference.py:1211-1215` |
| Not only those four: `_STREAMING_PRESET` hardcodes chunk/context/FIFO/speaker-cache geometry | `diarization/streaming_sortformer.py:130-140` |
| `pipeline_spec_from_resolved` maps only `enabled/backend/max_speakers/match_threshold` — every agent gets the literals | `pipeline/spec.py:690-698` |
| A revision the NeMo API rejects is dropped and the load retried **unpinned**, silently | `streaming_sortformer.py:229-236` |
| ★ The production STT image has **no NeMo** (the `nemo` extra conflicts with its torch; a separate build target). Sortformer fails closed with a named error and degrades to no labels wherever deployed | `apps/stt/docker/Dockerfile:240-248`, `apps/stt/pyproject.toml:172` |
| ★ The embedding path is gated on `sortformer_diarizer is None`, not on `backend` — a sortformer session whose diarizer failed to build would silently run embedding diarization | `streaming/session_manager.py:681`, `:701` |
| The gateway ships `models.embedding` whenever diarization is on, whatever the backend | `build-resolved-asr-spec.ts:201-214` |
| Batch ignores `backend` entirely (embedding or nothing) | `transcription/batch_service.py:443-497` |
| `ModelRefs.segmentation` exists but nothing on the agent path uses it; it means embedding-path refinement in the deprecated compiler | `dto.py:537`, `spec.py:659-664` |
| No `SPEAKER_DIARIZATION` row in the seed; the enum value and the `nemo` library vocabulary already exist, so no migration | `seed/ai-models/audio.ts:555-613`, `enums.prisma:146` |
| Any agent editor can already pick `backend: 'sortformer'` in the console | `parameters-form.tsx:109-121` |
| Dev database `hope`: 4 SPEECH_TO_TEXT agents, **0** with `backend: 'sortformer'` (read-only query, 2026-09-16). The cluster database has not been audited | — |

## Implementation Plan (proposed — Option A)

**Option A — a `diarizer` model role backed by a registry row (recommended).** New agent property
`audioFrontEnd.diarization.diarizerModelSlug` tagged `modelTaskType: 'SPEAKER_DIARIZATION'` (the console
renders a catalogue picker with no code change), plus `activityThreshold`. The gateway resolves it through
`ASR_AUX_MODEL_PATHS` exactly like `embeddingModelSlug`, ships `models.diarizer` only when the stage is on
with `backend: 'sortformer'` (and `models.embedding` only for `backend: 'embedding'`), and extends the
existing 409 to an enabled sortformer stage with no model. `apps/stt` loads the weights from the spec
(`resolve_weights_or_hf_id`, never dropping a pinned revision), selects the engine from the row's library
(`DIARIZER_ENGINE_BY_LIBRARY = {'nemo': 'sortformer'}`, the TASK-977 denoise precedent), shares one loaded
model per process, caches a failed load, and re-keys the embedding gate on `backend`. One SYSTEM seed row
carries the 2026-07-11 pin with a commit-hash revision. All wire additions are optional and omitted when
absent; deploy `apps/stt` before the gateway.

**Option B — keep sortformer runtime-owned, put model id/revision/threshold on the agent.** Rejected in the
proposal: an HF repo id on the agent is a locator stored as content (`sourceuri` is a forbidden key), gives
no platform veto, no tenant → SYSTEM cascade, and per-tenant clones make a revision bump an N-tenant edit.

**Option C — retire the `sortformer` backend until it is validated on a NeMo-capable GPU image.** Honest
about today (nothing deployed can run it), but discards the TASK-475 scaffold and the 2026-07-11 pin, needs a
Redis/queue drain to narrow the wire `Literal`, and bringing it back later is Option A anyway.

### Owner decisions

| ID | Question | Recommended |
|---|---|---|
| D-1 | Option A / B / C | **A** |
| D-2 | Model slot: new `diarizer` role or reuse `segmentation` | **new `diarizer`** (`segmentation` already means something else) |
| D-3 | Property name | **`diarizerModelSlug`** (engine chosen by `backend`, not by the name) |
| D-4 | Missing-model 409 code | **reuse `ASR_AGENT_DIARIZATION_MODEL_MISSING`**, message names the parameter |
| D-5 | Threshold tiers | **agent `activityThreshold` → dataclass default**; delete the inference duplicate |
| D-6 | Frame shift source | **row `_metadata.diarizer.frameShiftSec`** (a checkpoint fact rides the row, TASK-880) |
| D-7 | `_STREAMING_PRESET` in scope | **yes, as row metadata**; absent = checkpoint's own config |
| D-8 | Revision | **pinned commit hash**; the runtime raises instead of retrying unpinned |
| D-9 | Ship `models.embedding` for sortformer agents | **no** (gate on backend) |
| D-10 | Runtime posture when a bound model cannot load | **degrade once to no labels with a named reason, cache the failure** (the gateway 409 already fails selection closed) |
| D-11 | Existing enabled sortformer agents | **read-only audit before deploy, then 409, notify tenant admins** (published versions are immutable content) |
| D-12 | Batch job on a sortformer agent | **skip diarization with a named reason, never substitute embedding** |
| D-13 | Bind `diarizerModelSlug` on the seeded `realtime-transcription` agent | **no** (a SYSTEM-row veto would 409 every tenant's default ASR agent) |
| D-14 | Refuse a diarizer row of the wrong task type | **yes, for `diarizer`** |
| D-15 | Load per session or share per process | **per process, with a lock** |
| D-16 | Add `nemo` to `SINGLE_FILE_LIBRARIES` | **yes, if the HF repo is a single `.nemo` file** (unverified) |
| D-17 | Honour `stt.diarization.device` for sortformer | **yes** |
| D-18 | Mask speaker columns by `maxSpeakers` on the sortformer path | **defer, record** |
| D-19 | Remove sortformer literals from the deprecated YAML parser | **yes** |

### Lanes (after decisions)

| Wave | Lane | Owns | Depends on | Tier |
|---|---|---|---|---|
| W0 | Fixture freeze (orchestrator) | `tests/contracts/resolved-asr-spec.fixture.json` new `sortformerDiarization` case | decisions | Opus |
| W1 | Contract | `packages/types/src/{asr-spec,agent,asr-model-profile}.ts`, `packages/workflow-contract/src/agent-schemas.ts` + tests | W0 | Sonnet |
| W1 | Python runtime | `apps/stt/**` | W0 fixture | Opus |
| W2 | Gateway | `agent-resolver.service.ts`, `stt/agent-resolver/**`, `user/voiceProfile/**`, TS parity test | contract merged + built | Opus |
| W2 | Seed | `seed/ai-models/audio.ts`, `ai-model-registry-seed.test.ts` (33 → 34) | contract | Sonnet |
| W2 | Console test | `parameters-form.test.tsx` (test only) | contract `dist` | Sonnet |
| W3 | Docs + merge gate | architecture docs, TASK-977 cross-reference | all | Haiku |

Merge gate: both parity suites and every fixture consumer in one checkout, after rebuilding
`@arcaai/workflow-contract`. Deploy gate: cluster audit (D-11) → STT → gateway + console → seed.

### Unverified — confirm before or during implementation

Whether `SortformerEncLabelModel.from_pretrained` accepts a revision and `restore_from` an extracted
directory (the code marks both `# UNVALIDATED`); whether the HF repo is a single `.nemo` file, and the commit
hash to pin; whether one NeMo model can serve several sessions under a lock; whether any NeMo-capable GPU image
is deployed (the deployment repo was not read); the cluster database audit. **No runtime proof is possible on
the current image** — acceptance is contract and unit level.

## Implementation Summary

_Pending owner decisions._

## Change History

| Date | Change |
|---|---|
| 2026-09-16 | Ticket opened with a read-only design investigation; Option A recommended; 19 decisions pending. |
