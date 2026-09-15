# @arcaai/stt — deprecated browser speech-to-text plugin

`packages/stt`, npm package `@arcaai/stt` (version 3.5.0). **DEPRECATED** (`package.json`'s
`deprecated` field, TASK-865) — removed in R4. In-browser Whisper is retired; transcription is
backend streaming ASR selected by the tenant's ASR Agent (`@arcaai/vox` `audio.start({
agentSlug })`). The browser captures audio and renders results; it never runs a model. This
package keeps building and stays importable until R4 so existing hosts can migrate — do not add
new consumers. Register row: `docs/operations/deprecation-register.md` SDK section.

A speech-to-text plugin for `@arcaai/room` (peer dependency) with three provider modes: local
Whisper inference in the browser (Transformers.js + ONNX Runtime in a dedicated Web Worker), a
`'remote'` mode over a self-managed WebSocket, and a pipeline-aware streaming mode where the host
supplies the transport (`STTStreamingTransport`) — this is how `@arcaai/vox` drives the backend
STT service today. `react` is an optional peer dependency (only needed for `useSTT`).

## Layout

| Path | What it holds |
|---|---|
| `src/core/` | `STTProcessor` (+ `createSTT`), `AudioBufferManager`, worklet-based PCM capture with fallback |
| `src/providers/` | `LocalSTTProvider`, `RemoteSTTProvider` (deprecated alias `BackendSTTProvider`), `StreamingBackendSTTProvider`, `LocalSpeakerDiarizer` |
| `src/engines/` | `WhisperEngine` (main thread), `WhisperWorkerEngine` (Web Worker host) |
| `src/workers/` | `whisper.worker.ts` -> `dist/workers/whisper.worker.mjs` |
| `src/worklets/` | `stt-capture.worklet.ts` (AudioWorklet PCM capture) |
| `src/websocket/` | `WebSocketClient` (reconnect/backoff), `MessageHandler` |
| `src/hooks/` | `useSTT` (React) |
| `assets/README.md` | Model notes — Whisper models are fetched from the Hugging Face Hub at runtime, nothing is bundled here |
| `e2e/` | Playwright browser tests |

## Commands

Run from this directory, or `pnpm --filter @arcaai/stt <script>` from the repo root.

| Command | Effect |
|---|---|
| `pnpm build` / `pnpm dev` | tsup build (main bundle + worker bundle) / watch mode |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests; `:ui`, `:debug`, `:headed` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm nuke` | Remove build output (`nuke` also removes `node_modules`) |

## How it works

### Provider modes

| `features.provider` | Transport | When to use |
|---|---|---|
| `'local'` | None - Whisper runs in a Web Worker in the browser | Deprecated: on-device transcription, requires `features.modelId` |
| `'remote'` (default) | `sttSocket` WebSocket URL managed by this package | Server-side ASR with a simple socket contract |
| `'remote'` + `setStreamingTransport(...)` | Host-supplied `STTStreamingTransport` | Session-based streaming backends; how `@arcaai/vox` drives the STT service |

`@arcaai/vox` disables the `'local'` provider platform-wide: `LOCAL_TRANSCRIPTION_ENABLED = false`
in `packages/agentic-sdk-v2` makes `TranscriptionPipeline.resolveSTTRuntimeProvider()` never
resolve to `'local'`. Calling `createSTT({ features: { provider: 'local' } })` directly from this
package (outside `@arcaai/vox`) is unaffected and still runs on-device inference — which is
exactly the deprecated path this package is being removed for.

### Options (`STTOptions`)

| Option | Default | Description |
|---|---|---|
| `sttSocket` | - | WebSocket URL; required for `'remote'` unless a streaming transport is set |
| `sessionId` | auto-generated | Session identifier |
| `audio.language` | `'en-US'` | ISO 639-1 + ISO 3166-1 locale |
| `audio.sampleRate` / `channels` | `16000` / `1` | Whisper input format |
| `audio.chunkLengthS` / `overlapLengthS` | `30` / `5` | Chunking for continuous transcription |
| `features.provider` | `'remote'` | `'local' \| 'remote'` |
| `features.modelId` | - | Required for local; Whisper size or HF model ID |
| `features.diarization` / `numSpeakers` | `false` / `2` | Local speaker diarization (MFCC centroids) |
| `features.returnTimestamps` | `true` | `true` (chunk), `'word'`, or `false` |
| `features.task` | `'transcribe'` | `'translate'` requires a multilingual model; `.en` models reject it |
| `features.vadGate` | `false` | Disable continuous feeding; call `transcribeSegment()` per VAD segment |
| `features.device` / `quantized` | `'auto'` / `true` | Local inference device and quantization |
| `debugMode` | `false` | Config dump + per-result transcript JSON |

Key `STTProcessor` methods: `transcribeSegment(audio)`, `setLanguage(locale)`,
`setStreamingTransport(transport)`/`getStreamingTransport()`, `setReservedSpeakerId(id)`,
`getProviderType()`, `getStats()`.

Data events: `stt-transcription` (final), `stt-partial`, `stt-model-loaded`, `stt-speech-start`,
`stt-speech-end`, `stt-stats`. Errors are typed `STTError` with `STTErrorCode`
(`MODEL_LOAD_FAILED`, `WEBSOCKET_ERROR`, `NOT_SUPPORTED`, `INVALID_CONFIG`, ...).

### Workers, models, and runtime requirements

- Local inference runs in `dist/workers/whisper.worker.mjs`, loaded via
  `new Worker(new URL('./workers/whisper.worker.mjs', import.meta.url), { type: 'module' })`. The
  worker bundles `@huggingface/transformers`; audio buffers cross as transferables. Environments
  without `Worker` fall back to the main-thread `WhisperEngine`.
- Whisper models are fetched from the Hugging Face Hub on first use and cached by Transformers.js
  in browser storage — nothing is bundled in this package (see `assets/README.md`).
- WebGPU is used when available; other browsers run WASM. `getSTTBrowserSupport()` reports
  `recommendedProvider`/`recommendedDevice`.
- Multi-threaded ONNX (COOP/COEP): the worker enables threaded WASM only when the page is
  cross-origin isolated (needs `SharedArrayBuffer`):

  ```http
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

  Without these headers it silently falls back to single-threaded inference. Verify with
  `window.crossOriginIsolated === true`.
- Browser-only; ships a `react-server` exports-condition stub. Microphone permission is handled
  by the `@arcaai/room` track.

### Pipeline integration

```typescript
import { ProcessorPipeline } from '@arcaai/room';
import { NoiseFilterProcessor } from '@arcaai/noise-filter';
import { VADProcessor } from '@arcaai/vad';
import { createSTT } from '@arcaai/stt';

const pipeline = new ProcessorPipeline([
  new NoiseFilterProcessor(),
  new VADProcessor(),
  createSTT({ sttSocket: 'wss://api.example.com/ws/stt', features: { provider: 'remote' } }),
]);
await audioTrack.setProcessor(pipeline);
```

This NoiseFilter -> VAD -> STT ordering mirrors `@arcaai/vox`'s `TranscriptionPipeline`, but all
three client-side stages are deprecated for removal — see
[The browser never runs a model](../room/README.md#the-browser-never-runs-a-model).

## Related

- [`@arcaai/room`](../room/README.md) — the `BaseProcessor`/`AudioTrack` contract this package
  implements.
- [`@arcaai/vox`](../agentic-sdk-v2/README.md) — the SDK that drives the backend streaming
  replacement.
- [`assets/README.md`](assets/README.md) — model notes.
- `.claude/rules/08-vox-sdk.md` — the owner directive that the browser never runs a model.
