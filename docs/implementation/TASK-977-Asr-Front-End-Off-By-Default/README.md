# TASK-977 — ASR audio front-end stages are OFF until an admin enables them

| | |
|---|---|
| **Status** | In Progress |
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

_Pending._

## Change History

| Date | Change |
|---|---|
| 2026-09-16 | Ticket opened; four-lane audit recorded; owner decisions D-1(b), D-2..D-6 taken. |
