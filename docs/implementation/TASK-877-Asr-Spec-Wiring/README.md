# TASK-877 — Wire the dropped `ResolvedAsrSpec` fields; remove the platform duplicates

| | |
|---|---|
| **Status** | Review |
| **Type** | refactor / feature |
| **Program** | TASK-870 Configuration Governance, wave 2 lane B |
| **Branch** | `task-877-asr-spec-wiring` (worktree `hope-v2-task-877`) |
| **Base** | `030df76b5` off `dev-2.2` |
| **Merge target** | `dev-2.2` — merged by the orchestrator, not by this lane |

## Requirement Analysis

The owner's model (TASK-870 §Requirement Analysis, points 6 and 7): **the agent owns
per-session ASR behaviour**; an admin overwrites it by injected context or hard-coded node
values, never by a platform setting. A platform key that duplicates an agent concept is old
architecture and is **removed completely, not dual-homed**. Owner decision #9 widens the
`decoding` block with batch chunking for accuracy/performance.

Against that model, `ResolvedAsrSpec` today declares fields the runtime silently drops, and
the platform keys that used to carry those concepts are still the only thing in force:

| Spec field | Declared at | What actually happens |
|---|---|---|
| `streaming.endpointing` | `pipeline/spec.py:165-167` | never read — an agent asking for `"semantic"` gets fixed endpointing |
| `streaming.maxUtteranceSec` | same | never read, and no platform key behind it either — silently ignored |
| `streaming.partialIntervalMs` | same | never read — `stt.streaming.partialIntervalS` decides for every session |
| `decoding.vadFilter` | `pipeline/spec.py:150` | never read — `streaming/faster_whisper_asr.py:246` hardcodes `False` |

`pipeline_spec_from_resolved` (`pipeline/spec.py:300-372`) builds `StreamingConfig` from
`post_processing.stabilizer` alone (`:362`) and never touches `core.streaming`.
`_resolve_endpoint_config` (`streaming/session_manager.py:764-785`) looks for
`preprocessing.endpoint`, which the mapper never sets, so the entire `stt.semanticEndpoint.*`
family is the only reachable control.

## Current State Evaluation (verified at `030df76b5`)

- `AsrSpecStreaming` is `extra='forbid'`, so a new wire field must exist on the Python side
  BEFORE the gateway can send it. New fields are therefore declared **optional and omitted
  when unset** on both halves, which makes them safe in either merge order (TASK-876 adds the
  agent-schema names; this lane consumes them).
- `ASR_SPEC_MODEL_ROLES` (`packages/types/src/asr-spec.ts:30`) has no end-of-utterance role, so
  `stt.semanticEndpoint.modelId` is a free string with no registry row behind it.
- `execution_profile.py:377-387` still branches on `streaming_batch_wait_ms`,
  `streaming_embedding_device` and `streaming_multi_gpu_strategy` — TASK-872 removed the three
  descriptors, so those `Settings` fields can now only hold their code default. Dead.
- `_PARTIAL_INTERVAL_S = 0.4` (`streaming/preprocessor.py:70`) equals the descriptor default
  for `stt.streaming.partialIntervalS`, so dropping the settings read is behaviour-neutral.

## Implementation Plan

1. **Wire the spec.** New optional wire fields (`decoding.chunkLengthSec`,
   `decoding.strideLengthSec`, `streaming.semantic{…}`, `models.endpointing`) on both halves;
   `pipeline_spec_from_resolved` maps every previously-dropped field onto the runtime
   dataclasses; `build-resolved-asr-spec.ts` maps the matching agent `parameters`; the parity
   fixture grows a case that exercises them.
2. **Delete the platform duplicates** — `stt.streaming.partialIntervalS` and the six
   `stt.semanticEndpoint.*` — from the descriptors, `control_plane.py`, `Settings`, and the
   `session_manager` reads. (The brief called these "eight"; the enumerated list is SEVEN keys.
   The eighth duplicate is real but lives outside this lane — see §Follow-ups.)
3. **Delete the dead override branches** at `execution_profile.py:377-387` and the three
   orphaned `Settings` fields.
4. (budget) Punctuation: lazy per-spec load; delete `stt.punctuation.{enabled,modelName}`.
5. (budget) Diarization: honour `spec.models.embedding`; delete `stt.diarization.hfModelId`.

TDD order per deliverable: failing test → implement → gates.

## Implementation Summary

Deliverables 1–4 landed in full. Deliverable 5 is DEFERRED on evidence, not on budget — see
§Deliverable 5 below.

### 1. The spec is wired (`pipeline_spec_from_resolved`)

| Spec field | Now reaches | Where |
|---|---|---|
| `streaming.partialIntervalMs` | `StreamingConfig.partial_interval_s` → the preprocessor's emit cadence | `spec.py` `pipeline_spec_from_resolved`; `session_manager._build_preprocessor_vad_kwargs` |
| `streaming.maxUtteranceSec` | `StreamingConfig.max_utterance_sec` → `max_utterance_duration_ms`, applied AFTER the VAD block so the agent's cap outranks the front-end force-emit window | same |
| `streaming.endpointing` | `preprocessing.endpoint.enabled` — the field `_resolve_endpoint_config` already read and the mapper never set | `spec.py` `_endpoint_config` |
| `streaming.semantic{…}` (new, optional) | the four `EndpointConfig` tuning fields | `spec.py` `_endpoint_config` |
| `models.endpointing` (new role) | `EndpointConfig.model_id` — an EOU model bound like any other agent model | `spec.py` `_endpoint_config` |
| `decoding.vadFilter` | `InferenceConfig.vad_filter` → the faster-whisper transcribe kwargs (was a hardcoded `False`) | `faster_whisper_asr._build_decode_kwargs` |
| `decoding.{chunkLengthSec,strideLengthSec}` (new, optional; owner decision #9) | `InferenceConfig.{chunk_length_sec,stride_length_sec}` | `spec.py` |

**Wire optionality.** The four additive fields are declared optional and **omitted when unset**
on BOTH halves, never serialised as `null`. That is what makes them safe in either merge order:
the Python mirror is `extra='forbid'`, so a key one side has not learned is a contract drift, and
the existing fixture cases round-trip byte-for-byte unchanged. A shared `_Wire.OPTIONAL_FIELDS`
class-var implements it (and subsumes the bespoke serializer `AsrSpecModels` used to carry).

The fixture gained `agentOwnedStreamingBehaviour`, which exercises every new field — and, as a
by-product, the `fallback.kind: 'none'` state no case covered before.

### 2. Removed completely, not dual-homed (7 registry keys, 286 → **279**)

| Key | Descriptor | `control_plane` map | `Settings` field | Reader |
|---|---|---|---|---|
| `stt.streaming.partialIntervalS` | deleted | deleted | deleted | `session_manager` read deleted |
| `stt.semanticEndpoint.enabled` | deleted (was `killSwitch`) | deleted | deleted | `_resolve_endpoint_config` branch deleted |
| `stt.semanticEndpoint.minSilenceMs` | deleted | deleted | deleted | ″ |
| `stt.semanticEndpoint.maxSilenceMs` | deleted | deleted | deleted | ″ |
| `stt.semanticEndpoint.confidenceThreshold` | deleted | deleted | deleted | ″ |
| `stt.semanticEndpoint.minWords` | deleted | deleted | deleted | ″ |
| `stt.semanticEndpoint.modelId` | deleted | deleted | deleted | ″ |

**On the deleted kill-switch.** `stt.semanticEndpoint.enabled` was `killSwitch: true`. Its
replacement is not another flag: the agent chooses `streaming.endpointing`, and the platform's
veto is refusing to publish an `endpointing` model row — the same shape the rest of the agent's
model chain already has. A test asserts that a stale `_semantic_endpoint_enabled` attribute
cannot re-enable endpointing behind the agent's back.

### 3. Dead override branches

`execution_profile._apply_settings_overrides` lines 377-387 deleted, with the three orphaned
`Settings` fields (`streaming_batch_wait_ms`, `streaming_embedding_device`,
`streaming_multi_gpu_strategy`). TASK-872 had removed their descriptors, so they could hold
nothing but their own code default. `test_settings_override_all_fields` existed only to exercise
them and went with them.

### 4. Punctuation is the agent's decision (2 more keys, → **277**, executed)

The boot gate read `stt.punctuation.enabled` and returned early, so
`postProcessing.punctuation.enabled` was vetoed for every session — and since that key defaults
OFF, punctuation was globally unreachable whatever an agent asked for.
`stt.punctuation.modelName` separately duplicated `models.punctuation.slug`.

The service was ALREADY lazy and single-flight; what changed is where the model name comes from.
`initialize()`/`ensure_initialized()` take the spec's slug, boot warms nothing (process boot has
no spec — an honest `False`, not a failure), and the three entry points thread `model_name`.

The kill-switch is not needed to contain the hazard its description cited. Only the legacy
`cadence` wrapper fails under the pinned transformers 5.x — the exact name `cadence-fast` is the
direct loader and works — and `_enabled` latches off after ONE failed load, so a bad binding
costs one warning per process and degrades to passthrough. That latch is now asserted directly.

`stt.punctuation.{device,modelCacheDir,maxLength}` are KEPT: placement, cache location and window
width describe the HOST, not the agent.

### Deliverable 5 (diarization) — DEFERRED, with cause

The brief asked to make the embedding singleton honour `spec.models.embedding` and then delete
`stt.diarization.hfModelId`. Investigation says that is not safe as specified:

- **The defect is real and precisely located.** `session_manager.py:570-579` resolves a
  per-session embedding model ONLY from an *inline* `ModelRef`
  (`emb_ref.is_inline and emb_ref.inline`), but `spec.py:410` emits a *slug* `ModelRef`. So an
  agent's `models.embedding` never reaches the embedding service, and every agent session
  silently falls back to the platform singleton (`session_manager.py:646-649` →
  `embedding_service.py:291`).
- **Fixing it as written would break voice profiles.** `UserVoiceProfile.embedding` is
  `Unsupported("vector(256)")` (`packages/database/src/prisma/db_main/user.prisma:257`), and the
  enrollment seed uses `pyannote/wespeaker-voxceleb-resnet34-LM`
  (`seed/91-user.ts:715`, 256-d) — which is exactly `stt.diarization.hfModelId`'s default
  (`settings.py:521`). The contract fixture's platform agent instead binds
  `speechbrain/spkrec-ecapa-voxceleb` (192-d). Wiring the slug through would feed 192-d vectors
  into a `vector(256)` column, and the descriptor already warns that a dimension mismatch "will
  fail every enrollment".
- **The enrollment half is outside this lane anyway.**
  `voice_profile/extraction_service.py:113` reads `diarization_hf_model_id` directly and is not
  in this lane's ownership, so deleting the key would split diarization and enrollment across two
  embedding spaces.

`stt.diarization.hfModelId` is therefore NOT purely an agent-concept duplicate: it declares the
embedding SPACE that enrolled `UserVoiceProfile` rows live in. Removing it needs an owner
decision about whether an agent may re-space diarization while enrollment stays pinned. Recorded
for wave 3 with the file:line above.

## Follow-ups this lane could not make (outside its ownership)

| What | Where | Why it matters |
|---|---|---|
| `semanticEndpoint.enabled` feature-flag descriptor is now ORPHANED | `packages/applications/src/services/settings-registry/descriptors/feature-flags.descriptors.ts:149-156`, asserted at `__tests__/fail-mode.governance.test.ts:264` | This is the EIGHTH duplicate. It is `tier: 'env'` bound to the bare `SEMANTIC_ENDPOINT_ENABLED`, whose only reader was the `Settings.semantic_endpoint_enabled` field this lane deleted. Nothing reads it now. |
| `decoding.{chunkLengthSec,strideLengthSec}` have no batch consumer yet | `apps/stt/src/stt/transcription/batch_service.py:1245-1246` still reads `settings.transcription_chunk_length_s` / `transcription_stride_length_s` unconditionally | The spec now carries the per-agent values onto `InferenceConfig`; a two-line preference of `config.chunk_length_sec` / `config.stride_length_sec` over the platform settings completes the path. `transcription/**` is not this lane's. |
| Boot punctuation warm-up is now always a no-op | `apps/stt/src/stt/worker.py:115-117` calls `punctuation_service.initialize()` with no model name | Correct behaviour (boot has no spec, so `False` and no warm-up), but the call itself is now vestigial and belongs with a `worker.py` owner. |
| Generated env artifacts are stale for the nine deleted keys | `.env.sample`, `apps/stt/.env.sample`, `turbo.json#globalEnv`, `env-surface.generated.md`, `scripts/generated/python-env-surface.json` | Their `*__MOVED_TO_CONTROL_PLANE` entries came from the deleted `Settings` fields. Regeneration (`pnpm env:sync`) is an orchestrator step — this lane is barred from artifact regeneration. |

## Verification

| Gate | Result |
|---|---|
| `pnpm stt:test` | `1 failed, 3187 passed, 6 skipped, 3 xfailed, 210 errors` — baseline shape (the failure is the pre-existing `test_minio_credentials_default_to_empty`; the 210 errors are integration tests with no test DB) |
| `pnpm stt:lint` | `All checks passed!` |
| `pnpm stt:typecheck` | `Success: no issues found in 140 source files` |
| `pnpm --filter @arcaai/types build` / `typecheck` | clean (the package ships NO `test` script) |
| `pnpm --filter @arcaai/applications test` | `659 passed | 1 skipped (660)` files, `11528 passed | 4 skipped (11532)` tests |
| `pnpm --filter @arcaai/applications build` / `lint` | clean / `0 errors, 213 warnings` (none in files this lane changed) |
| Contract parity, TS half | `4 passed (4)` files, `54 passed (54)` — includes the new fixture case and the omit-when-absent lock |
| Contract parity, Python half | `11 passed` |
| `pnpm lint` (repo) | `Failed: @arcaai/api#lint` — **5 pre-existing errors**, all in `apps/api/tests/e2e/{auth-throttle-per-endpoint,harness-gate,shared-component-contracts}.spec.ts`. Verified identical at base `030df76b5`; this lane changed zero files under `apps/api` |

**Test-count reconciliation** (measured by diffing collected test ids, not assumed). Collected:
base `030df76b5` = **3401**, HEAD = **3407**, net **+6** — from **+35 added** and **−29 removed**.

Added (35): 15 `test_task877_spec_wiring.py` · 9 `test_task877_session_wiring.py` ·
6 `test_task877_spec_owned.py` · 2 `test_resolved_spec_parity.py` (the new fixture case's
parametrization plus `test_a_fallbackless_spec_declares_kind_none`) · 1 each in
`test_service.py`, `test_inference_punctuation.py`, `test_preprocessor_wiring_kwargs.py`
(rewrites of tests that pinned deleted behaviour).

Removed (29): **18** parametrized cases over the nine deleted `CONTROL_PLANE_KEYS` — 9 keys ×
the two `test_task799_{control_plane,descriptor_parity}` tests, which iterate that mapping, so
they shrink automatically and prove the Python and TypeScript sides still agree in both
directions — plus **11** hand-deleted tests whose only subject was a deleted platform key
(the six `TestPunctuationDisabled` cases, `test_disabled_settings_never_load`,
`test_settings_override_all_fields`, `test_make_endpointer_enabled_via_settings`,
`test_partial_interval_always_present_from_settings`,
`test_setting_default_is_lowered_below_one_second`).

Base run `3401 − 210 errors − 6 skipped − 3 xfailed − 1 failed = 3181` reproduces the brief's
quoted baseline exactly; HEAD gives **3187**, which is the observed run.

**Worktree source guard**: `assert_source_tree(["stt", "hope_env", "hope_otel",
"hope_runtime_models"])` passed on the first run in this worktree; `stt` resolves to
`…/hope-v2-task-877/apps/stt/src/stt/__init__.py` and `hope_env` to
`…/hope-v2-task-877/packages/py-env/src/hope_env/__init__.py`.

## Change History

| Date | Change |
|---|---|
| 2026-09-05 | Ticket opened; plan recorded against the verified base state. |
| 2026-09-05 | Deliverables 1–3: spec wiring (`streaming.*`, `decoding.vadFilter`, the two chunking fields, the `streaming.semantic` block, the `endpointing` model role), seven platform duplicates deleted, dead override branches removed. Registry 286 → 279. |
| 2026-09-05 | Deliverable 4: punctuation follows the spec; `stt.punctuation.{enabled,modelName}` deleted. Registry 279 → 277. |
| 2026-09-05 | Deliverable 5 deferred with cause: wiring `spec.models.embedding` as specified would feed 192-d ECAPA vectors into the `vector(256)` `UserVoiceProfile.embedding` column and split diarization from enrollment. Needs an owner decision. |
