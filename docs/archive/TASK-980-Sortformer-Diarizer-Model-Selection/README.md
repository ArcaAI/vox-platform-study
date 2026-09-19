# TASK-980 — Retire the Sortformer diarization backend (its model was a literal no agent could govern)

| | |
|---|---|
| **Status** | Review — code complete; cluster audit + ordered deploy owed |
| **Type** | refactor (removal) |
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

## Owner decision (2026-09-16)

| # | Question | Decided |
|---|---|---|
| D-1 | Option A / B / C | **C — retire the `sortformer` backend until a NeMo-capable GPU image is validated.** Implement now. |
| — | Load-failure posture, and D-2..D-19 | **Moot under C.** Answered "degrade" and "accept all recommended" in the same round, but every one of them governs Option A's `diarizer` role, which C does not build. Kept below as the starting point if Sortformer is revived. |
| D-11 | Audit before deploy | **Still applies, and matters more:** under C a stored agent that says `sortformer` is refused, not silently coerced. Dev DB `hope` has 0 such agents; the cluster DB must be audited before the gateway deploys. |

The 2026-07-11 owner pin (`nvidia/diar_streaming_sortformer_4spk-v2.1`, NVIDIA Open Model License accepted)
is **retired with the backend**. Reviving Sortformer means re-establishing that decision and building Option A.

## Implementation Plan (Option C — decided)

**Wire shape stays; the vocabulary narrows.** `audioFrontEnd.diarization.backend` stays a required wire key
(removing a required key breaks both `extra='forbid'` halves), but its only legal value becomes `embedding`.
That keeps the door open for a future backend without a shape change.

| Layer | Change |
|---|---|
| Types | `AsrSpecDiarizationBackend` → `'embedding'` only (`packages/types/src/asr-spec.ts`) |
| Agent schema | diarization `backend` enum → `['embedding']`, default `'embedding'` (`packages/workflow-contract/src/agent-schemas.ts`); an agent saved with `sortformer` now fails schema validation |
| Gateway resolver | **No silent coercion.** Today `oneOf(diarization.backend, …, 'embedding')` turns an unknown backend into `embedding`. An ENABLED stage whose stored backend is anything but `embedding` is refused with a named 409; a DISABLED stage emits `embedding` (nothing runs). `assertDiarizationRunnable` loses its sortformer exemption. |
| Voice profile | `enrollmentTarget`'s "enabled but no embedding model ⇒ sortformer" 400 branch becomes unreachable — remove or re-word it truthfully |
| Python runtime | narrow the `spec.py` / `dto.py` Literals; delete `diarization/streaming_sortformer.py`, the `sortformer_*` knobs, `_build_sortformer_diarizer` and its wiring in `session_manager.py` / `inference.py`; the embedding gate no longer keys on `sortformer_diarizer is None`; the deprecated YAML parser refuses `backend: sortformer` by name; the `nemo` extra STAYS (it also serves `models/nemo_loader.py`) |
| Fixture | no change expected — all six cases already use `embedding`; both parity suites must stay green |
| Docs | architecture docs, deprecation register, `apps/stt/README.md`, TASK-977 cross-reference |

**Deploy order is the reverse of Option A:** the gateway first (it stops emitting `sortformer`), then let any
Redis-persisted session and queued Dramatiq job carrying `sortformer` drain, then `apps/stt` (whose narrowed
Literal would reject them on recovery). With zero sortformer agents in dev this is a formality there, not on
the cluster.

| Lane | Owns | Tier |
|---|---|---|
| **G — contract + gateway (TS)** | `packages/types/src/asr-spec.ts`, `packages/workflow-contract/src/agent-schemas.ts` + tests, `packages/applications/src/services/stt/agent-resolver/**`, `packages/applications/src/services/user/voiceProfile/**`, `tests/contracts/resolved-asr-spec-parity.contract.test.ts` | Sonnet (refusal semantics fixed by the orchestrator) |
| **P — Python runtime** | `apps/stt/**` | Opus (multi-file deletion with wiring, recovery and replay risk) |
| Docs + merge gate | `docs/**` | orchestrator |

## Option A design (not built — the revival path)

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

### Option A decisions (moot under C; kept for revival)

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

### Option A lanes (not used)

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

Both lanes merged into `dev-2.2` (`merge(task-980): lane G` then `lane P`).

### What changed

| Layer | Result |
|---|---|
| Contract | `AsrSpecDiarizationBackend = 'embedding'`; agent schema `backend` enum `['embedding']`, default `'embedding'` — an agent saved with `sortformer` fails schema validation |
| Gateway | `assertDiarizationBackendSupported` (`build-resolved-asr-spec.ts`) runs in `buildAsrSpecCore` BEFORE the front-end is built, so it covers the primary, the fallback agent and the model-level fallback core. ENABLED + stored backend present and not `embedding` → **409 `ASR_AGENT_DIARIZATION_BACKEND_UNSUPPORTED`** (a stored `null` counts as present); disabled → `embedding`; absent → `embedding`. The spec always carries `backend: 'embedding'`. `assertDiarizationRunnable` lost its sortformer exemption; enabled embedding with no model is still 409 `ASR_AGENT_DIARIZATION_MODEL_MISSING`. |
| Voice profile | The unreachable "enabled but no embedding model" 400 became a guard that returns the resolver's own 409 `ASR_AGENT_DIARIZATION_MODEL_MISSING` — a misconfigured agent, not a bad request. API docs and the regenerated OpenAPI/portal artifacts match. |
| `apps/stt` | Wire and `DiarizationConfig` Literals narrowed; `diarization/streaming_sortformer.py`, the four `sortformer_*` knobs, `_build_sortformer_diarizer` and all inference wiring deleted (net −1,062 lines across the lane); the embedding gate is plain `effective_diarization` (behaviour-identical for embedding sessions); legacy YAML naming it raises `UnsupportedDiarizationBackendError`; a persisted session spec naming it is skipped on recovery with a logged reason (pinned by `test_task980_retired_backend_recovery.py`). The `nemo` extra stays. |
| Diarization-quality scaffold | Kept — DER/JER metrics and fixtures are backend-agnostic and still measure embedding diarization; only wording changed |
| Docs | `docs/architecture/overview.md`, `docs/architecture/model-and-config-plane.md`, `docs/operations/deprecation-register.md` (new TASK-980 section with the deploy precondition), `docs/operations/retrieval-corpus-ingestion/README.md` |

### Found only at the merge gate

`test_nothing_under_src_names_the_retired_backend` walked every file under `apps/stt/src/`, including the
gitignored `stt.egg-info/` an editable install leaves behind, whose `SOURCES.txt` still listed the deleted module.
Green in the lane's fresh worktree, red in the primary checkout — and likely in any CI job with an editable
install. It now skips `*.egg-info` like `__pycache__`.

### Evidence (primary checkout, after both merges)

| Gate | Result |
|---|---|
| `@arcaai/types` build · `@arcaai/workflow-contract` build + test | OK · 54 files / 957 tests |
| TS parity contract + `stt/agent-resolver/__tests__` | 6 files / 141 tests |
| `CI=true pnpm stt:test:unit` (includes the Python parity suite) · `stt:lint` · `stt:typecheck` | 3450 passed · clean · clean (141 files) |
| `@arcaai/applications` test | 14126+ passed; one known environmental file (test DB on :5433 down) and one pre-existing flaky test (`consultation-timeout-sweep` 1-ms clock race, failed 1 of 3 isolated runs on untouched code — queued as its own fix) |
| `@arcaai/api` test | 320 files / 4634 tests |
| `@arcaai/admin-console` test · typecheck · lint | 343 files / 3288 tests · clean · clean |
| Contract fixture | byte-identical to the base (`FIXTURE_UNCHANGED`) |

`api:openapi:check` / `api:portal:check` / `vox-node gen:admin:check` were run green in lane G's worktree after
regeneration; they were not re-run in the primary checkout because a watch-mode API was running from it and
`api:build` would race it.

### Deploy precondition — owed

1. Audit the target database for SPEECH_TO_TEXT agent versions whose `parameters.audioFrontEnd.diarization`
   is `enabled: true` with `backend: 'sortformer'` (dev `hope`: 0). Notify those tenants' admins — published
   versions are immutable content and cannot be auto-fixed.
2. Deploy the gateway (stops emitting `sortformer`).
3. Drain Redis-persisted streaming sessions and queued Dramatiq batch jobs carrying a sortformer spec — a queued
   job would otherwise fail validation and spend its 3 retries.
4. Deploy `apps/stt`.

## Change History

| Date | Change |
|---|---|
| 2026-09-16 | Ticket opened with a read-only design investigation; Option A recommended; 19 decisions pending. |
| 2026-09-16 | Owner decision: Option C — retire the backend, implement now. Option A kept as the revival design. |
| 2026-09-16 | Lanes G (contract + gateway) and P (Python runtime) merged; egg-info fragility in the absence test fixed at the merge gate; docs updated; status Review pending the cluster audit and ordered deploy. |
