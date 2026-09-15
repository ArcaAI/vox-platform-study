# @arcaai/types — shared TypeScript type definitions

Shared TypeScript type definitions for the HOPE platform: audio capture, transcription,
diarization, voice recognition, LLM integration, storage, model management, and the resolved
agent/ASR/TTS runtime contracts shared across the gateway, harness, SDKs, and Python services. A
types-only ESM package with no runtime code and no dependencies.

## Layout

| Path | What it holds |
|---|---|
| `src/index.ts` | Barrel export (all modules below except `global.ts`) |
| `src/audio.ts` | `AudioFormat`, `AudioCaptureConfig`, capture state/error enums |
| `src/cloud-storage.ts` | `StorageProvider`, `StorageTopology` enums |
| `src/common.ts` | `ApiResponse<T>`, `PaginatedResponse<T>`, `Timestamp`, `UUID`, `AsyncStatus` |
| `src/diarization.ts` | `SpeakerSegment`, `DiarizationResult`, clustering options |
| `src/global.ts` | Browser-API global declarations (not exported via index) |
| `src/llm.ts` | `LLMProvider`, `LLMMessage`, `LLMResponse`, `LLMSummary` |
| `src/meeting.ts` | `Meeting`, `MeetingStatus`, Create/UpdateMeetingInput |
| `src/model-management.ts` | `ModelMetadata`, `ModelCategory`/`Priority`/`Status`, download progress |
| `src/speaker-mapping.ts` | `SpeakerMapping`, recognition results, `ConfidenceLevel` |
| `src/stepper.ts` | Voice-enrollment wizard step types |
| `src/storage.ts` | Browser storage records (audio files, settings, cleanup) |
| `src/transcription.ts` | `TranscriptionSegment`, `TranscriptionResult`, `TranscriptionJob` |
| `src/vad.ts` | `VADConfig`, `VADPreset`, `SpeechSegment`, VAD state/error enums |
| `src/voice-recognition.ts` | `VoiceProfile`, enrollment sessions, audio quality metrics |
| `src/agent.ts` | The resolved-agent contract (`ResolvedAgent`, `AgentTask`, `AgentFundingTier`) shared by the gateway, the harness `core.agent` activity, and the SDKs |
| `src/asr-spec.ts` | `ResolvedAsrSpec` — the gateway-resolved speech-to-text runtime contract handed to `apps/stt`, replacing `AsrPipeline.configYaml` |
| `src/asr-model-profile.ts` | The per-model ASR decode profile (`AiModel._metadata.asr`) the ASR spec builder folds in |
| `src/tts-spec.ts` | `ResolvedTtsSpec` — the gateway-resolved text-to-speech runtime contract handed to `apps/tts`, replacing the `TenantTtsConfig` fold |
| `src/__tests__/` | Vitest suites |

## Commands

| Command | package.json script | From repo root |
|---|---|---|
| Build | `tsc --build` | `pnpm --filter @arcaai/types build` |
| Typecheck | `tsc --noEmit` | `pnpm --filter @arcaai/types typecheck` |
| Clean | `rm -rf dist *.tsbuildinfo` | `pnpm --filter @arcaai/types clean` |

There is no lint or per-package test script — `src/__tests__/asr-model-profile.test.ts` runs as
part of the root `pnpm test:unit` sweep instead. The package compiles to declaration-heavy ESM
output (`dist/`) consumed via the package `exports` map.

## How it works

### The resolved-spec contracts are cross-language locks, not just TS types

`ResolvedAsrSpec` and `ResolvedTtsSpec` each have exactly ONE producer in `@arcaai/applications`
(`buildResolvedAsrSpec()` / `buildResolvedTtsSpec()`, both fed by `AgentResolverService`) and exactly
ONE Python mirror (`apps/stt/src/stt/pipeline/spec.py`, `apps/tts/src/tts/spec.py`). Both sides of
each contract validate against the SAME committed fixture under `tests/contracts/`, which is the
cross-language parity lock — changing a field on the TS side without updating the Python dataclass
and the fixture breaks that lock. `null` on a tuning field means "the engine default applies": the
spec carries what the Agent said, normalized, and never restates the Python service's own defaults.

### Module overview

| Module | Contents |
|---|---|
| `common` | `ApiResponse<T>`, `ApiError`, `PaginationParams`, `PaginatedResponse<T>`, `Timestamp`, `UUID`, `AsyncStatus` |
| `audio` | Audio formats/encodings, capture configuration, `AudioCaptureSource`/`State`/`ErrorCode` enums, recording metadata |
| `transcription` | `TranscriptionSegment`, `Word`, `Speaker`, `TranscriptionResult`, `TranscriptionOptions`, `TranscriptionJob` |
| `diarization` | Speaker segmentation and clustering types, `DiarizationResult`, progress and error types |
| `voice-recognition` | `VoiceProfile`, `VoiceEmbedding`, enrollment sessions/samples, audio quality thresholds |
| `speaker-mapping` | Speaker-to-role mapping, recognition confidence (`ConfidenceLevel`, `getConfidenceLevel`), `DEFAULT_RECOGNITION_CONFIG` |
| `vad` | `VADConfig`, `VADPreset` (`aggressive`/`balanced`/`permissive`), speech segments, VAD state machine |
| `llm` | `LLMProvider` (`ollama`, `azure-openai`, `lm-studio`, `openai-compat`), chat message/response shapes, summary types |
| `model-management` | `ModelMetadata`, `ModelCategory`/`ModelPriority`/`ModelStatus` enums, download progress and storage info |
| `storage` | Browser-side storage records (audio files, settings, cleanup policies) and `StorageErrorCode` |
| `cloud-storage` | `StorageProvider` and `StorageTopology` enums used by the backend blob-storage abstraction |
| `stepper` | Voice-enrollment step unions and `StepperConfig<T>` |
| `meeting` | Consultation-session (`Meeting`) types |
| `agent` | `ResolvedAgent`, `AgentTask`, `AgentFundingTier` — the resolved-agent contract |
| `asr-spec` | `ResolvedAsrSpec` and its supporting types |
| `asr-model-profile` | `AiModelAsrProfile`, `AiModelAsrProfileDecoding` |
| `tts-spec` | `ResolvedTtsSpec` and its supporting types |

`global.ts` contains only browser-API global declarations and is intentionally excluded from the
barrel export.

### Usage

```typescript
// packages/applications/src/services/baseServices/storage/providers/blob-storage.provider.factory.ts
import { StorageProvider } from '@arcaai/types';

// packages/utils/src/date.ts
import type { Timestamp } from '@arcaai/types';

// packages/utils/src/model-registry.ts
import type { ModelMetadata } from '@arcaai/types';
import { ModelCategory, ModelPriority } from '@arcaai/types';
```

Because the package is types-first, prefer `import type` where possible; runtime values are limited
to enums and a handful of constants (for example `DEFAULT_RECOGNITION_CONFIG`,
`VOICE_ENROLLMENT_STEPS`, `ENROLLMENT_PHRASES`).

## Gotchas

- `src/agent.ts`, `asr-spec.ts`, `asr-model-profile.ts`, and `tts-spec.ts` are shared with Python via
  committed fixtures under `tests/contracts/` — do not change a field's shape without updating the
  matching Python dataclass and fixture in the same change.

## Related

- [`06-python-services.md`](../../.claude/rules/06-python-services.md) — the `apps/stt` agent-resolved config path this package's `asr-spec` backs
- [`08-vox-sdk.md`](../../.claude/rules/08-vox-sdk.md) — the ASR/TTS agent-selection model these types express
