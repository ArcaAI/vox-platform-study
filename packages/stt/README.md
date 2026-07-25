# @arcaai/stt

Speech-to-text plugin for `@arcaai/room`. Supports three provider modes: local Whisper inference in the browser (Transformers.js + ONNX Runtime, run inside a dedicated Web Worker with optional WebGPU), remote transcription over a self-managed WebSocket, and a pipeline-aware streaming mode where the host application supplies the transport (used by `@arcaai/vox` against the STT backend).

Last updated: 2026-07-04

## Where it fits

| Direction | Package | Relationship |
|---|---|---|
| Depends on | `@arcaai/room` (peer) | Extends `BaseProcessor`; attaches to an `AudioTrack` |
| Depends on | `@huggingface/transformers`, `onnxruntime-web` | Whisper inference (bundled into the worker) |
| Consumed by | `@arcaai/vox` | Final stage of `TranscriptionPipeline` (NoiseFilter → VAD → STT); vox injects an `STTStreamingTransport` for backend streaming |

`react` is an optional peer dependency (only needed for `useSTT`).

## Directory structure

```
packages/stt/
├── src/
│   ├── core/          # STTProcessor (+ createSTT), AudioBufferManager (chunk/overlap),
│   │                  # audioCapture (worklet-based PCM capture with fallback)
│   ├── providers/     # LocalSTTProvider, RemoteSTTProvider (deprecated alias:
│   │                  # BackendSTTProvider), StreamingBackendSTTProvider, LocalSpeakerDiarizer
│   ├── engines/       # WhisperEngine (main thread), WhisperWorkerEngine (Web Worker host)
│   ├── workers/       # whisper.worker.ts → dist/workers/whisper.worker.mjs
│   ├── worklets/      # stt-capture.worklet.ts (AudioWorklet PCM capture)
│   ├── websocket/     # WebSocketClient (reconnect/backoff), MessageHandler
│   ├── hooks/         # useSTT (React)
│   ├── types/         # STTOptions, TranscriptionResult, WS messages, STTError
│   ├── utils/         # Resampling (prepareFloat32ForWhisper, 16 kHz), browser support
│   └── index.ts       # Public barrel export
├── assets/            # Model notes (Whisper models download from the HF Hub at runtime)
├── e2e/               # Playwright browser tests
└── tsup.config.ts     # Main bundle + standalone worker bundle
```

## Provider modes

| `features.provider` | Transport | When to use |
|---|---|---|
| `'local'` | None — Whisper runs in a Web Worker in the browser | Offline/on-device transcription; requires `features.modelId` |
| `'remote'` (default) | `sttSocket` WebSocket URL managed by this package | Server-side ASR with a simple socket contract |
| `'remote'` + `setStreamingTransport(...)` | Host-supplied `STTStreamingTransport` | Session-based streaming backends; this is how `@arcaai/vox` drives the STT service |

> **`@arcaai/vox` disables the `'local'` provider platform-wide (TASK-545).** This package's local Whisper provider is untouched — gated OFF, not deleted — via a kill switch in the CONSUMER: `LOCAL_TRANSCRIPTION_ENABLED` (`packages/agentic-sdk-v2/src/core/constants.ts`) makes `TranscriptionPipeline.resolveSTTRuntimeProvider()` never resolve to `'local'` while it reads `false`. Calling `createSTT({ features: { provider: 'local', ... } })` directly from this package (outside `@arcaai/vox`) is unaffected and still runs on-device inference.

## Public API overview

### React hook

```tsx
import { useAudioTrack } from '@arcaai/room';
import { useSTT } from '@arcaai/stt';

function Transcriber() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: true,
  });

  const { isReady, isProcessing, currentTranscript, finalTranscripts, error } = useSTT({
    track,
    sttSocket: 'wss://your-api.example.com/ws/stt',
    autoAttach: true,
    audio: { language: 'en-US' },
    features: { provider: 'remote' },
    onTranscription: (result) => console.log('Final:', result.text),
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start'}
      </button>
      <div>{isProcessing ? 'Processing…' : 'Idle'}</div>
      <div>{currentTranscript}</div>
      <ul>{finalTranscripts.map((t, i) => <li key={i}>{t.text}</li>)}</ul>
      {error && <div>{error.message}</div>}
    </div>
  );
}
```

The hook also exposes `isLoading` / `loadProgress` (local model download), `stats`, and methods `attach`, `detach`, `transcribeSegment`, `clear`, `setLanguage`.

### Processor with local Whisper

```typescript
import { STTProcessor } from '@arcaai/stt';

const stt = new STTProcessor({
  audio: { language: 'en-US', chunkLengthS: 30, overlapLengthS: 5 },
  features: {
    provider: 'local',
    modelId: 'tiny',          // 'tiny' | 'base' | 'small' | 'medium' | 'large' | HF model ID
    device: 'auto',           // 'webgpu' | 'wasm' | 'auto'
    returnTimestamps: 'word', // true | 'word' | false
  },
  onModelProgress: (p) => console.log(`Model: ${(p.progress * 100).toFixed(0)}%`),
});

stt.on('data', (payload) => {
  if (payload.type === 'stt-transcription') console.log('Final:', payload.data.text);
  if (payload.type === 'stt-partial') console.log('Partial:', payload.data.text);
});

await audioTrack.setProcessor(stt);
```

### Options (`STTOptions`)

| Option | Default | Description |
|---|---|---|
| `sttSocket` | — | WebSocket URL; required for `'remote'` unless a streaming transport is set |
| `sessionId` | auto-generated | Session identifier (`generateSessionId()`) |
| `audio.language` | `'en-US'` | ISO 639-1 + ISO 3166-1 locale |
| `audio.sampleRate` / `channels` | `16000` / `1` | Whisper input format |
| `audio.chunkLengthS` / `overlapLengthS` | `30` / `5` | Chunking for continuous transcription |
| `features.provider` | `'remote'` | `'local' \| 'remote'` |
| `features.modelId` | — | Required for local; Whisper size or HF model ID |
| `features.diarization` / `numSpeakers` | `false` / `2` | Local speaker diarization (`LocalSpeakerDiarizer`, MFCC centroids) |
| `features.returnTimestamps` | `true` | `true` (chunk), `'word'`, or `false` |
| `features.task` | `'transcribe'` | `'translate'` requires a multilingual model; `.en` models reject it |
| `features.codeSwitching` | `false` | Let Whisper auto-detect language per segment |
| `features.vadGate` | `false` | Disable continuous feeding; call `transcribeSegment()` per VAD segment |
| `features.device` / `quantized` | `'auto'` / `true` | Local inference device and quantization |
| `prompt` | — | Initial prompt to bias transcription |
| `voiceProfile` | — | `{ id?, reservedSpeakerId?, similarityThreshold? }` pins the enrolled speaker's diarization slot |
| `debugMode` | `false` | Config dump + per-result transcript JSON, `[ARCAAI:DEBUG]` prefix |
| `enableStats` / `statsInterval` | `false` / `1000` | Emit `stt-stats` events |

Key `STTProcessor` methods: `transcribeSegment(audio)`, `setLanguage(locale)`, `setStreamingTransport(transport)` / `getStreamingTransport()`, `setReservedSpeakerId(id)`, `getProviderType()`, `getProvider()`, `getStats()`, `getOptions()`, `getSessionId()`, `getLanguage()`, `isSupported()`.

Data events: `stt-transcription` (final), `stt-partial`, `stt-model-loaded`, `stt-speech-start`, `stt-speech-end`, `stt-stats`. Errors are typed `STTError` with `STTErrorCode` (`MODEL_LOAD_FAILED`, `WEBSOCKET_ERROR`, `NOT_SUPPORTED`, `INVALID_CONFIG`, ...).

## Workers, models, and special runtime requirements

- **Whisper Web Worker**: local inference runs in `dist/workers/whisper.worker.mjs`, loaded by `WhisperWorkerEngine` via `new Worker(new URL('./workers/whisper.worker.mjs', import.meta.url), { type: 'module' })`. The worker bundles `@huggingface/transformers`; audio buffers cross the boundary as transferables. Crash recovery restarts the worker with backoff (default 3 retries). Environments without `Worker` fall back to the main-thread `WhisperEngine`.
- **Model downloads**: Whisper models are fetched from the Hugging Face Hub on first use and cached by Transformers.js in browser storage; nothing is bundled. Size guide: tiny ~40 MB, base ~75 MB, small ~240 MB, medium ~770 MB, large ~1.5 GB (see [`assets/README.md`](assets/README.md)).
- **WebGPU**: used when available (Chrome/Edge 113+); other browsers run WASM. `getSTTBrowserSupport()` reports `recommendedProvider` / `recommendedDevice`.
- **Multi-threaded ONNX (COOP/COEP)**: the worker enables threaded WASM (`min(8, hardwareConcurrency)` threads) only when the page is cross-origin isolated, because threading needs `SharedArrayBuffer`:

  ```http
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```

  Without these headers it silently falls back to single-threaded inference. Verify with `window.crossOriginIsolated === true`.
- **Audio capture**: prefers an AudioWorklet capture path (`stt-capture.worklet.ts`, coalesced frames) with a legacy fallback; probe with `isAudioWorkletUsable()`.
- Browser-only; ships a `react-server` exports-condition stub. Microphone permission is handled by the `@arcaai/room` track.

## Pipeline integration

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

This NoiseFilter → VAD → STT ordering is the same one `@arcaai/vox` builds in its `TranscriptionPipeline`.

## Commands

From this directory:

| Command | Action |
|---|---|
| `pnpm build` / `pnpm dev` | tsup build (main bundle + worker bundle) / watch mode |
| `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests; `:ui`, `:debug`, `:headed` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm nuke` | Remove build output (nuke also removes `node_modules`) |

From the repo root: `pnpm --filter @arcaai/stt build` (same pattern for `test`, `lint`, etc.).

## License

MIT
