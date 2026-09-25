# @arcaai/stt — audio capture + backend streaming speech-to-text transport

`packages/stt`, npm package `@arcaai/stt` (version 4.0.0). TASK-1006 (following TASK-865) removed
the in-browser Whisper provider, its engines, its Web Worker, and the `useSTT` React hook — the
browser never runs a model. Transcription is backend streaming ASR selected by the tenant's ASR
Agent (`@arcaai/vox` `audio.start({ agentSlug })`). What remains is audio CAPTURE
(`createAudioCapture`, worklet-based PCM with a `ScriptProcessorNode` fallback) and the STREAMING
TRANSPORT to the backend (`RemoteSTTProvider`/`StreamingBackendSTTProvider` over `WebSocketClient`).
Register row: `docs/operations/deprecation-register.md` SDK section.

A speech-to-text plugin for `@arcaai/room` (peer dependency) with two remote transport modes: a
`RemoteSTTProvider` over a self-managed WebSocket, and a pipeline-aware streaming mode where the
host supplies the transport (`STTStreamingTransport`) — this is how `@arcaai/vox` drives the
backend STT service today. `STTProvider.type` is now a single-member `'remote'` union kept for
source compatibility.

## Layout

| Path             | What it holds                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `src/core/`      | `STTProcessor` (+ `createSTT`), `AudioBufferManager`, worklet-based PCM capture with fallback |
| `src/providers/` | `RemoteSTTProvider` (deprecated alias `BackendSTTProvider`), `StreamingBackendSTTProvider`    |
| `src/worklets/`  | `stt-capture.worklet.ts` (AudioWorklet PCM capture)                                           |
| `src/websocket/` | `WebSocketClient` (reconnect/backoff), `MessageHandler`                                       |
| `e2e/`           | Playwright browser tests                                                                      |

Removed by TASK-1006: `src/engines/` (`WhisperEngine`, `WhisperWorkerEngine`, `BaseEngine`),
`src/workers/whisper.worker.ts`, `src/hooks/` (`useSTT`), `src/providers/LocalSTTProvider.ts`,
`src/providers/LocalSpeakerDiarizer.ts`, and every local-only type/util in `src/types/index.ts`
(`WhisperModelSize`, `ComputeDevice`, `WhisperTask`, `LocalProviderConfig`, `ModelLoadProgress`,
`isWhisperModelSize`, `normalizeModelId`, `parseModelId`, `resolveLocalWhisperModel`,
`DEFAULT_LOCAL_WHISPER_SIZE`) and `src/utils/browserSupport.ts`
(`isWebGPUSupported`/`isWebGPUAvailable`/`isTransformersJsSupported`/`getRecommendedDevice`/
`getRecommendedProvider`/`isWebAssemblySupported`). `react`/`react-dom` are no longer dependencies
(only the removed `useSTT` hook needed them).

## Commands

Run from this directory, or `pnpm --filter @arcaai/stt <script>` from the repo root.

| Command                                           | Effect                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm build` / `pnpm dev`                         | tsup build (main bundle + react-server stub) / watch mode           |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests                                                   |
| `pnpm test:e2e`                                   | Playwright browser tests; `:ui`, `:debug`, `:headed` variants exist |
| `pnpm lint`                                       | ESLint (`--max-warnings 0`)                                         |
| `pnpm typecheck`                                  | `tsc --noEmit`                                                      |
| `pnpm clean` / `pnpm nuke`                        | Remove build output (`nuke` also removes `node_modules`)            |

## How it works

### Transport modes

| Configuration                | Transport                                         | When to use                                                                |
| ---------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `sttSocket` (default)        | `sttSocket` WebSocket URL managed by this package | Server-side ASR with a simple socket contract                              |
| `setStreamingTransport(...)` | Host-supplied `STTStreamingTransport`             | Session-based streaming backends; how `@arcaai/vox` drives the STT service |

### Options (`STTOptions`)

| Option                                  | Default        | Description                                                 |
| --------------------------------------- | -------------- | ----------------------------------------------------------- |
| `sttSocket`                             | -              | WebSocket URL; required unless a streaming transport is set |
| `sessionId`                             | auto-generated | Session identifier                                          |
| `audio.language`                        | `'en-US'`      | ISO 639-1 + ISO 3166-1 locale                               |
| `audio.sampleRate` / `channels`         | `16000` / `1`  | Input audio format                                          |
| `audio.chunkLengthS` / `overlapLengthS` | `30` / `5`     | Chunking for continuous transcription                       |
| `features.provider`                     | `'remote'`     | `'remote'` only — kept for source compatibility             |
| `features.diarization` / `numSpeakers`  | `false` / `2`  | Server-side speaker diarization                             |
| `features.returnTimestamps`             | `true`         | `true` (chunk), `'word'`, or `false`                        |
| `debugMode`                             | `false`        | Config dump + per-result transcript JSON                    |

Key `STTProcessor` methods: `transcribeSegment(audio)` (throws `STTError(NOT_SUPPORTED)` — no local
model to run it against), `setLanguage(locale)`, `setStreamingTransport(transport)` /
`getStreamingTransport()`, `getProviderType()` (always `'remote'`), `getStats()`.

Data events: `stt-transcription` (final), `stt-partial`, `stt-speech-start`, `stt-speech-end`,
`stt-stats`. (`stt-model-loaded` stays a typed event for source compatibility but nothing emits it
any more — there is no local model to load.) Errors are typed `STTError` with `STTErrorCode`
(`WEBSOCKET_ERROR`, `NOT_SUPPORTED`, `INVALID_CONFIG`, ...).

### Runtime requirements

- Browser-only; ships a `react-server` exports-condition stub (still relevant: `AudioWorklet` /
  `WebSocket` / `AudioContext` are unavailable on the server). Microphone permission is handled by
  the `@arcaai/room` track.
- `getSTTBrowserSupport()` reports `audioWorklet` / `webSocket` / `sharedArrayBuffer` /
  `backendSupported` — no WebGPU/Transformers.js/compute-device fields any more.

### Pipeline integration

```typescript
import { ProcessorPipeline } from '@arcaai/room';
import { createSTT } from '@arcaai/stt';

const pipeline = new ProcessorPipeline([createSTT({ sttSocket: 'wss://api.example.com/ws/stt' })]);
await audioTrack.setProcessor(pipeline);
```

`@arcaai/vox`'s `TranscriptionPipeline` composes `createAudioCapture` with this package's streaming
transport the same way — see
[The browser never runs a model](../room/README.md#the-browser-never-runs-a-model).

## Related

- [`@arcaai/room`](../room/README.md) — the `BaseProcessor`/`AudioTrack` contract this package
  implements.
- [`@arcaai/vox`](../agentic-sdk-v2/README.md) — the SDK that drives the backend streaming path.
- `.claude/rules/08-vox-sdk.md` — the owner directive that the browser never runs a model.
