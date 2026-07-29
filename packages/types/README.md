# @arcaai/types

Shared TypeScript type definitions for the HOPE platform: audio capture, transcription, diarization, voice recognition, LLM integration, storage, and model management. A types-only ESM package with no runtime code and no dependencies.

Last updated: 2026-07-04

## Position in the stack

`@arcaai/types` is a leaf package. Current workspace consumers:

| Consumer               | What it uses                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arcaai/applications` | `StorageProvider`, `StorageTopology` (from `cloud-storage.ts`) in the blob-storage provider factory (`src/services/baseServices/storage/providers/`) |
| `@arcaai/utils`        | `Timestamp` (date helpers), `ModelMetadata`, `ModelCategory`, `ModelPriority` (model registry)                                                       |

## Directory structure

```
src/
├── index.ts              # Barrel export (all modules below except global.ts)
├── audio.ts              # AudioFormat, AudioCaptureConfig, capture state/error enums
├── cloud-storage.ts      # StorageProvider, StorageTopology enums
├── common.ts             # ApiResponse<T>, PaginatedResponse<T>, Timestamp, UUID, AsyncStatus
├── diarization.ts        # SpeakerSegment, DiarizationResult, clustering options
├── global.ts             # Browser-API global declarations (not exported via index)
├── llm.ts                # LLMProvider, LLMMessage, LLMResponse, LLMSummary
├── meeting.ts            # Meeting, MeetingStatus, Create/UpdateMeetingInput
├── model-management.ts   # ModelMetadata, ModelCategory/Priority/Status, download progress
├── speaker-mapping.ts    # SpeakerMapping, recognition results, ConfidenceLevel
├── stepper.ts            # Voice-enrollment wizard step types
├── storage.ts            # Browser storage records (audio files, settings, cleanup)
├── transcription.ts      # TranscriptionSegment, TranscriptionResult, TranscriptionJob
├── vad.ts                # VADConfig, VADPreset, SpeechSegment, VAD state/error enums
└── voice-recognition.ts  # VoiceProfile, enrollment sessions, audio quality metrics
```

## Module overview

| Module              | Contents                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `common`            | `ApiResponse<T>`, `ApiError`, `PaginationParams`, `PaginatedResponse<T>`, `Timestamp`, `UUID`, `AsyncStatus`            |
| `audio`             | Audio formats/encodings, capture configuration, `AudioCaptureSource`/`State`/`ErrorCode` enums, recording metadata      |
| `transcription`     | `TranscriptionSegment`, `Word`, `Speaker`, `TranscriptionResult`, `TranscriptionOptions`, `TranscriptionJob`            |
| `diarization`       | Speaker segmentation and clustering types, `DiarizationResult`, progress and error types                                |
| `voice-recognition` | `VoiceProfile`, `VoiceEmbedding`, enrollment sessions/samples, audio quality thresholds                                 |
| `speaker-mapping`   | Speaker-to-role mapping, recognition confidence (`ConfidenceLevel`, `getConfidenceLevel`), `DEFAULT_RECOGNITION_CONFIG` |
| `vad`               | `VADConfig`, `VADPreset` (`aggressive`/`balanced`/`permissive`), speech segments, VAD state machine                     |
| `llm`               | `LLMProvider` (`ollama`, `azure-openai`, `lm-studio`, `openai-compat`), chat message/response shapes, summary types     |
| `model-management`  | `ModelMetadata`, `ModelCategory`/`ModelPriority`/`ModelStatus` enums, download progress and storage info                |
| `storage`           | Browser-side storage records (audio files, settings, cleanup policies) and `StorageErrorCode`                           |
| `cloud-storage`     | `StorageProvider` and `StorageTopology` enums used by the backend blob-storage abstraction                              |
| `stepper`           | Voice-enrollment step unions and `StepperConfig<T>`                                                                     |
| `meeting`           | Consultation-session (`Meeting`) types                                                                                  |

`global.ts` contains only browser-API global declarations and is intentionally excluded from the barrel export.

## Usage

Real imports from the workspace:

```typescript
// packages/applications/src/services/baseServices/storage/providers/blob-storage.provider.factory.ts
import { StorageProvider } from '@arcaai/types';

// packages/utils/src/date.ts
import type { Timestamp } from '@arcaai/types';

// packages/utils/src/model-registry.ts
import type { ModelMetadata } from '@arcaai/types';
import { ModelCategory, ModelPriority } from '@arcaai/types';
```

Because the package is types-first, prefer `import type` where possible; runtime values are limited to enums and a handful of constants (for example `DEFAULT_RECOGNITION_CONFIG`, `VOICE_ENROLLMENT_STEPS`, `ENROLLMENT_PHRASES`).

## Commands

| Command | package.json script         | From repo root                      |
| ------- | --------------------------- | ----------------------------------- |
| Build   | `tsc --build`               | `pnpm --filter @arcaai/types build` |
| Clean   | `rm -rf dist *.tsbuildinfo` | `pnpm --filter @arcaai/types clean` |

There are no test or lint scripts; the package compiles to declaration-heavy ESM output (`dist/`) consumed via the package `exports` map.

## Conventions

- Types-only by default: new modules should contain interfaces, type aliases, enums, and small constant objects only — no side-effectful runtime code.
- Every module added to `src/` must be re-exported from `src/index.ts` (except ambient declaration files like `global.ts`).
- This package must remain dependency-free so both browser packages and backend services can consume it.
