# TASK-977 — ASR audio front-end stages are OFF until an admin enables them

| | |
|---|---|
| **Status** | Review |
| **Type** | bugfix / refactor |
| **Branch** | four lanes → `dev-2.2` |
| **Base** | `6ae4a535c` |

## Requirement Analysis

Owner directive, 2026-09-16:

> These features/functions must be disabled by default, unless the admin configures and enables them:
> voice-activity-detection for segmentation; voice embedding and retrieval for diarization;
> noise-suppression/cancellation.
> The resampling must be enabled by default to make sure the audio input meets model input requirements.

The rule this generalises is the one already stated in `09-infrastructure-devops.md`: **model SELECTION
fails closed**. A stage that runs because nobody said otherwise is a selection made by the platform on
the tenant's behalf. Diarization already obeys this (TASK-887); VAD and denoise do not.

### Owner decisions, 2026-09-16

| # | Decision | Chosen |
|---|---|---|
| D-1 | VAD default | **(b)** resolver defaults `false` **and** the SYSTEM agent seeds `false`. Genuinely off until opted in. The behaviour change (Silero segmentation → energy fallback) was raised and accepted. |
| D-2 | Denoise | Explicit `enabled` (default `false`). Binding a denoise model no longer enables denoising by itself. |
| D-3 | Fail-closed guards | VAD and denoise get the diarization treatment — enabled with no model bound is refused, not silently emitted. |
| D-4 | Aux model shipping | A disabled stage ships no model, and the STT cache-warm is gated on `enabled`. "Disabled" must cost zero model loads. |
| D-5 | Resample flag | Keep it, default `true`, and make the contract honest — streaming must read it, with a forced override on a genuine rate mismatch. |
| D-6 | Browser ungated paths | Close them now, not at R4. |

## Current State Evaluation

Verified at `6ae4a535c` by a four-lane read-only audit.

| Fact | Where |
|---|---|
| `vad.enabled` is a hardcoded literal `true`; the agent's opinion is never read and no schema key exists to set it | `build-resolved-asr-spec.ts:213`, `agent-schemas.ts:318-334` |
| The one seeded ASR lineage (`realtime-transcription`, cloned into every tenant) binds `silero-vad` | `seed/25-agents.ts:276` |
| Denoise enablement is DERIVED from model binding: `models.denoise ? 'medium' : 'off'` | `build-resolved-asr-spec.ts:205` |
| Diarization is already correct — explicit `enabled`, default `false`, seeded `false`, 409 `ASR_AGENT_DIARIZATION_MODEL_MISSING` when enabled without a model | `build-resolved-asr-spec.ts:221,425-433` |
| `auxModels()` copies every resolved role into the spec regardless of the enable flags | `build-resolved-asr-spec.ts:189-197` |
| `_load_optional(model_refs.vad, ...)` warms and pins VAD weights keyed only on ref presence | `session_manager.py:2058` |
| VAD/denoise/diarization EXECUTION is correctly gated in `apps/stt` — the gates are fine, the flags reaching them are not | `session_manager.py:1920`, `:604-628`, `:657-747` |
| Streaming never reads `resample` (zero references under `streaming/`); batch warns and resamples anyway | `preprocessor.py`, `preprocessing.py:143-157` |
| The browser gate is typed `(stage: 'noiseFilter' \| 'vad')`; `useLocalVoiceEmbedding` and the raw `useVAD`/`useNoiseFilter` re-exports are outside it | `TranscriptionPipeline.ts:139-146`, `useLocalVoiceEmbedding.ts`, `plugins.ts:44,52` |
| The console boolean widget is `checked={value === true}` and emits `undefined` when off — for `resample`/`normalize` that silently resolves to `true` server-side | `parameters-form.tsx:136-146` |

Out of scope, recorded: the `stt.vad-sensitivity` `GlobalSetting` (`seed/11-global-setting.ts:251`) has no
backend reader left — only the retiring browser SDK's `ModelRegistry`. Removing it is a settings-registry
change with its own migration; not folded into this ticket.

## Implementation Plan

Four lanes, disjoint by file. Lane 4 depends on Lane 1 because `task-930-agents.test.ts:133` validates
the seeded parameters against `AGENT_PARAMETER_SCHEMAS`, so the schema must declare `vad.enabled` /
`denoise.enabled` before the seed may set them.

### Wave 1 — parallel

| Lane | Owns | Delivers |
|---|---|---|
| **L1 — contract + resolver** | `packages/workflow-contract/src/agent-schemas.ts`, `packages/applications/src/services/stt/agent-resolver/**`, `tests/contracts/resolved-asr-spec.fixture.json`, `apps/api/src/modules/streaming/__tests__/**` | D-1 resolver half, D-2, D-3, D-4 gateway half, D-5 schema defaults |
| **L2 — Python runtime** | `apps/stt/**` | D-4 runtime half (cache-warm gated on `enabled`), D-5 runtime half (streaming honours `resample`, forced override on mismatch) |
| **L3 — browser SDK** | `packages/agentic-sdk-v2/**`, `packages/vad/**`, `packages/noise-filter/**` | D-6 |

### Wave 2 — after L1 merges

| Lane | Owns | Delivers |
|---|---|---|
| **L4 — seed + console** | `packages/database/src/prisma/db_main/seed/25-agents.ts` (+ seed tests), `apps/admin-console/src/features/agents/**` | D-1 seed half; the console widget reads `schema.default` so "off" in the UI means what the resolver means |

## Implementation Summary

All six decisions landed across five lanes, merged into `dev-2.2` in two waves.

### The behaviour, before and after

| Stage | Before | After |
|---|---|---|
| VAD | `enabled` hardcoded `true`; no schema key existed, so no admin could turn it off. The seeded agent bound `silero-vad`, so every tenant ran it. | Declared `audioFrontEnd.vad.enabled`, `default: false`, read by the resolver. The seed declares it `false` and keeps the model slug bound, so enabling it is one switch and never trips the new guard. |
| Noise suppression | No `enabled` key. Derived: binding a denoise model silently set `level: 'medium'`. | Declared `audioFrontEnd.denoise.enabled`, `default: false`. Enablement is never inferred from a binding. `enabled === false ⟺ level === 'off'`, and `'off'` wins a disagreement so the old `level` spelling still works as a kill switch. |
| Diarization / voice embedding | Already correct (TASK-887). | Unchanged, plus the embedding model is no longer shipped when the stage is off. |
| Resampling | `default: true` in the resolver, but the flag was decorative: streaming never read it (zero references under `streaming/`). | Still `true` by default. The streaming path now reads it and forces a resample with a WARNING on a genuine rate mismatch — the batch path's existing posture. Disabling is honoured only where it is a no-op. |
| Browser | `clientInference.allow` gated exactly two stages. `useLocalVoiceEmbedding` (WavLM) and the raw `useVAD`/`useSTT`/`useNoiseFilter` re-exports ran models with no gate. | One predicate, `isClientInferenceAllowed`, failing closed. Both paths gated; `useSTT` narrowly, only at `features.provider === 'local'`, so capture-only use is untouched. |

### D-3 asymmetry — VAD guarded, denoise deliberately not

`ASR_AGENT_VAD_MODEL_MISSING` joins `ASR_AGENT_DIARIZATION_MODEL_MISSING`: Silero needs weights, and
`_load_vad_service` resolves them from `models.vad.localPath` — with no row it passes `None` and falls
back to whatever the HuggingFace cache holds, which is a selection nobody made.

Denoise gets **no** guard, and that is the finding rather than an oversight. The engines are
RUNTIME-owned: `StreamingDenoiser.initialize()` constructs `pyrnnoise.RNNoise(sample_rate=48000)`,
`DeepFilterNet3StreamingDenoiser.initialize()` calls `init_df(default_model='DeepFilterNet3')`, and
both paths pick the engine by NAME from `DenoiseConfig.engine`. `spec.py` never sets `engine` from
`models`, so the denoise model ref fed nothing but the cache warm. Requiring a bound row would have
refused the working default configuration.

### What only the merge could catch

`cloudWithAgentFallback` in the contract fixture became the D-4 negative case (a bound denoise model
with the stage off). The Python half of that same fixture asserted the opposite —
`denoise.enabled is True`, `strength > 0.5`, `models['rnnoise']` present. The TypeScript lane owned
the fixture but not `apps/stt`; the Python lane ran against the pre-change fixture. The fixture header
already says *"change it with both suites open"*, which the file partition made impossible for any one
lane. Resolved by keeping the fixture (its polarity design is sound) and moving the Python
denoise-mapping coverage to `twoConnectionsOfOneVendor`, so both poles stay pinned in both languages.

A second merge-only trap: `apps/admin-console` consumes `@arcaai/workflow-contract` from its built
`dist`, so the console suite fails against a stale build even when the source is correct. Rebuild that
package after a schema change before trusting a console run in the primary checkout.

### Evidence (primary checkout, post-merge)

| Gate | Result |
|---|---|
| `@arcaai/workflow-contract test` | 53 files / 950 tests |
| `@arcaai/applications test` | 14106 passed; 1 failed FILE, 0 failed tests (see below) |
| `@arcaai/api test` | 320 files / 4628 passed |
| `@arcaai/database test` | 92 files / 1826 passed |
| `@arcaai/vox test` / typecheck / lint | 247 files / 3743 passed; both clean |
| `@arcaai/admin-console test` / typecheck / lint / build | 340 files / 3266 passed; all clean |
| `pnpm stt:test:unit` / `stt:lint` / `stt:typecheck` | 3466 passed; ruff clean; mypy clean (142 files) |
| TS ↔ Python contract parity | 21 passed |

`membership-bounded-sync.integration.test.ts` fails in `beforeAll` with ECONNREFUSED — the isolated
test infra (port 5433) is down. Zero failed TESTS, nothing in this diff is in its import graph, and it
reproduces at the base commit. Environmental, out of scope.

### Deliberately not done

- ~~`VadConfig.enabled` in `apps/stt` stays `True`.~~ Flipped in the follow-up below, on the owner's call.
- **`stt.vad-sensitivity` `GlobalSetting`** (`seed/11-global-setting.ts:251`) has no backend reader
  left — only the retiring browser SDK's `ModelRegistry`. Retiring it is a settings-registry change
  with its own migration.
- **Enum controls with schema defaults** (`diarization.backend`, and `responseFormat`/`memory` on
  `TEXT_GENERATION`) share the display gap the boolean control just had: a `"Default"` placeholder
  rather than the effective value. Outside D-1..D-6.

### Follow-up — every control decided per agent (owner, 2026-09-16)

Owner asks: flip `VadConfig.enabled` in `apps/stt`, and make sure the three features are controlled
granularly on each platform agent. An audit found the per-agent path already holds for request bodies
(sessions and jobs carry only the agent selector), workflow nodes (no audio-stage config), fallback
agents (each chain maps its OWN front-end, keyed by runtime key) and the engine-internal VAD filter
(`decoding.vadFilter`, agent-only, default off). It found four gaps, closed here:

| Gap | Fix |
|---|---|
| **Four** sites defaulted VAD on in `apps/stt`, not one: `VadConfig.enabled`, the legacy YAML parser's `get("enabled", True)`, and the two D-4 warm gates whose fallback is "this stage's own dataclass default". | All four → `False`. The warm-gate fallback test now derives its expectation from the dataclasses, so it still tells "reads each default" from "blanket off". |
| **The agent could not choose its denoise engine.** `pipeline_spec_from_resolved` never set `DenoiseConfig.engine`, so binding the `deepfilternet3` row still ran RNNoise; only the deprecated YAML path could pick. | The bound row's serving library selects it — `DENOISE_ENGINE_BY_LIBRARY` in `models/cache.py` (`pyrnnoise`→`rnnoise`, `deepfilternet`→`deepfilternet3`). No row keeps RNNoise; a row naming no known engine library, including none, fails closed with `UnsupportedDenoiseEngineError`. |
| **A hardware profile could switch denoise on.** `ExecutionProfile.denoise_enabled_default` was `True` on four profiles. Unreachable, but a machine-level enable. | Field removed from the dataclass and all five profiles; no pipeline config ⇒ denoise off. |
| **VAD and denoise models were free-text inputs** in the console while the embedding model was a catalogue picker. | `modelTaskType` annotations on both; the seeded `realtime-transcription` agent now declares all five controls explicitly so each tenant clone is self-describing. |

**A regression D-4 caused, found by the audit.** `VoiceProfileService.enrollmentTarget()` read
`spec.models.embedding`, which D-4 omits whenever diarization is off. The seeded agent (diarization
off, `embeddingModelSlug` set) therefore answered enrollment with a 400 telling the admin to set a
slug that was already set. Service tests mock the spec, so nothing went red. Owner decision: **refuse
enrollment while diarization is off** — enrolling computes a voice embedding. Now a 409
`ASR_AGENT_DIARIZATION_DISABLED` (same `{ code, message }` body as the ASR resolver's own refusals),
raised before any audio reaches `apps/stt`; enabled-with-no-model is a truthful 400 naming the
`sortformer` backend. This reverses TASK-887's "enrol ahead of enabling". The console renders an
explanatory blocked state with the enroll actions disabled and a visible reason; existing profiles
still list. `AgenticClient` now preserves the gateway's `code` on `AgenticError.context.code` —
before, every 409 on this path was indistinguishable without parsing the message.

Evidence after the follow-up merges (primary checkout): `stt` unit 3478 · ruff/mypy clean ·
`workflow-contract` 952 · `database` 1826 · `applications` 14109 (same one environmental file) ·
`api` 4632 · `vox` 3745 · `admin-console` 3274 · contract parity + resolver 43 · `api:openapi:check`,
`api:portal:check`, `vox-node gen:admin:check` clean, and a fresh regeneration of `openapi.json` /
`route-manifest.json` produces no diff.

Still owed for the follow-up:
- ~~Runtime verification of the blocked-enrollment card~~ — **done 2026-09-16** against the live dev
  stack as `arcaai_admin`: `GET /api/hope/voice-profiles/enrollment-target` → **409**; the card renders
  the gateway's own `ASR_AGENT_DIARIZATION_DISABLED` message and the deep link; "New profile" and
  "Enroll voice profile" are `disabled` with visible reasons wired via `aria-describedby`; axe
  (wcag2a/aa, 21a/aa, 22aa) over `main` = **0 violations in both dark and light themes**.
- **The deep link does not filter.** `/agents?task=SPEECH_TO_TEXT` lands on the unfiltered Agents
  list: the grid keeps filters in the `f` URL parameter and never reads `task`. The three retired-route
  redirects (`/audio/pipelines`, `/ai-model-defaults`, `/ai-configuration`) have the same gap — it
  predates this ticket.
- ~~Sortformer diarization uses a hardcoded model id~~ — **resolved by TASK-980 (2026-09-16):** the backend was retired rather than wired to the registry (owner decision C).

### Verification still owed before this reaches the cluster

D-1(b) changes runtime behaviour for every tenant — sessions fall from Silero VAD to the energy-based
fallback in `StreamingPreprocessor._run_energy_fallback` until an admin opts in. The gates above prove
the wiring, not the transcription quality. A listening pass on a real consultation is owed before
deploy, and the owner accepted that trade when choosing (b) over (a).

## Change History

| Date | Change |
|---|---|
| 2026-09-16 | Ticket opened; four-lane audit recorded; owner decisions D-1(b), D-2..D-6 taken. |
| 2026-09-16 | All five lanes merged into `dev-2.2`. Status Review, pending the listening pass D-1(b) owes. |
| 2026-09-16 | Runtime check of the blocked-enrollment card on the live stack: 409 from the gateway, disabled actions with reasons, axe 0 violations in both themes. |
| 2026-09-16 | Follow-up: `VadConfig.enabled` → False (four sites); per-agent denoise engine; `ExecutionProfile.denoise_enabled_default` removed; catalogue model pickers; explicit agent controls; voice enrollment refused while diarization is off (fixes a D-4 regression). |
