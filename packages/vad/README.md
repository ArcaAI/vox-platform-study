# @arcaai/vad

Voice Activity Detection plugin for `@arcaai/room` built on Silero VAD (v5 or legacy) via `@ricky0123/vad-web` and ONNX Runtime WebAssembly. Detects speech in real time, emits speech start/end events with the captured audio segment, and exposes both a `VADProcessor` class and a `useVAD` React hook.

Last updated: 2026-07-04

## Where it fits

| Direction | Package | Relationship |
|---|---|---|
| Depends on | `@arcaai/room` (peer, `^0.1.0`) | Extends `BaseProcessor`; attaches to an `AudioTrack` |
| Depends on | `@ricky0123/vad-web` | Wraps its `MicVAD` runtime (Silero ONNX models + worklet) |
| Consumed by | `@arcaai/vox` | Middle stage of `TranscriptionPipeline` (NoiseFilter → VAD → STT); segments gate STT |

`react` is an optional peer dependency (only needed for `useVAD`).

## Directory structure

```
packages/vad/
├── src/
│   ├── processors/    # VADProcessor (+ createVAD factory) wrapping MicVAD
│   ├── hooks/         # useVAD (React)
│   ├── utils/         # Browser support, 16 kHz resampler, FrameAccumulator/AudioRingBuffer
│   ├── types/         # VADOptions, VADStats, event payloads, VADError
│   ├── constants.ts   # Pinned CDN versions (VAD_WEB_VERSION, ORT_WEB_VERSION) + default asset paths
│   └── index.ts       # Public barrel export
├── examples/          # basic-usage.tsx, transcription-integration.ts
├── assets/            # Model notes only — ONNX models load from vad-web/CDN or a self-hosted path
├── e2e/               # Playwright browser tests
└── tsup.config.ts     # ESM (.mjs) + CJS (.cjs) build
```

## Public API overview

### React hook

```tsx
import { RoomProvider, useAudioTrack } from '@arcaai/room';
import { useVAD } from '@arcaai/vad';

function VoiceRecorder() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: true,
    echoCancellation: true,
  });

  const { isSpeaking, speechProbability, stats } = useVAD({
    track,
    model: 'v5',
    positiveSpeechThreshold: 0.5,
    minSpeechMs: 250,
    autoAttach: true,
    onSpeechEnd: (audio) => {
      // audio is a Float32Array at 16 kHz — hand it to transcription
      console.log('Speech segment:', audio.length, 'samples');
    },
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>
        {isCapturing ? 'Stop' : 'Start'}
      </button>
      <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
      <div>Probability: {(speechProbability * 100).toFixed(1)}%</div>
      <div>Segments: {stats?.speechSegmentsDetected ?? 0}</div>
    </div>
  );
}
```

Complete runnable versions live in [`examples/basic-usage.tsx`](examples/basic-usage.tsx) and [`examples/transcription-integration.ts`](examples/transcription-integration.ts).

### Processor usage

```typescript
import { createVAD } from '@arcaai/vad';

const vad = createVAD({ model: 'v5', positiveSpeechThreshold: 0.5 });

vad.on('data', (payload) => {
  switch (payload.type) {
    case 'vad-speech-start':      // speech onset detected
    case 'vad-speech-real-start': // confirmed (exceeded minSpeechMs)
      break;
    case 'vad-speech-end':
      // payload.data.audio: Float32Array @ 16 kHz, plus segment timing metadata
      break;
    case 'vad-misfire':           // segment shorter than minSpeechMs
    case 'vad-frame':             // per-frame probability
    case 'vad-stats':             // when enableStats: true
      break;
  }
});

await audioTrack.setProcessor(vad);
```

### Options (`VADOptions`)

| Option | Default | Description |
|---|---|---|
| `model` | `'v5'` | `'v5'` (512-sample frames) or `'legacy'` (1536-sample frames) |
| `positiveSpeechThreshold` | `0.5` | Probability above which a frame counts as speech |
| `negativeSpeechThreshold` | `0.35` | Probability below which a frame counts as non-speech |
| `preSpeechPadMs` / `postSpeechPadMs` | `300` / `300` | Audio padding around detected speech |
| `minSpeechMs` | `250` | Segments shorter than this fire `vad-misfire` |
| `redemptionMs` | `1400` | Contiguous non-speech required to end a segment |
| `silenceResetMs` | `5000` | Rebuild MicVAD after this much silence to reset the Silero LSTM state; `0` disables |
| `sampleRate` | `16000` | Output rate for speech-end audio (model always runs at 16 kHz) |
| `baseAssetPath` / `onnxWASMBasePath` | pinned jsDelivr CDN | Self-host the vad-web assets / ORT WASM binaries |
| `submitUserSpeechOnPause` | `false` | Emit the in-flight segment when pausing |
| `enableStats` / `statsInterval` | `false` / `1000` | Emit `vad-stats` data events |
| `debugMode` | `false` | Log configuration with the `[ARCAAI:DEBUG]` prefix |

Key `VADProcessor` methods: `isSpeaking()`, `getSpeechProbability()`, `getStats()`, `getModel()`, `getOptions()`, `updateOptions(options)`, `updateThresholds(pos, neg)`, `pause()`, `start()`, `reset()` (force-rebuild MicVAD / LSTM state), `resetStats()`, plus inherited `enable()` / `disable()` / `destroy()`.

## Model assets and version pinning

ONNX models and the vad-web worklet are not bundled. By default they load from jsDelivr using version-pinned URLs derived from the exported constants `VAD_WEB_VERSION` (`0.0.30`) and `ORT_WEB_VERSION` (`1.27.0`) — see `src/constants.ts`. These must match `package.json`; a unit test enforces the invariant, because the ONNX Runtime WASM ABI is not stable across minor versions.

For production, prefer self-hosting: copy the `@ricky0123/vad-web` dist assets and `onnxruntime-web` WASM binaries to your server and set `baseAssetPath` / `onnxWASMBasePath`.

## Runtime requirements

- Browser only: WebAssembly + AudioWorklet (Chrome 66+, Firefox 76+, Safari 17.4+, Edge 79+). Older Safari/iOS can use `model: 'legacy'`; `getRecommendedModel()` picks one automatically.
- Microphone permission is handled by the `@arcaai/room` track you attach to.
- Multi-threaded ONNX Runtime requires cross-origin isolation (COOP/COEP headers, `window.crossOriginIsolated === true`); without it, inference silently runs single-threaded. Same gating as `@arcaai/stt` — see `../stt/README.md` for the exact headers.
- Support probing: `isVADSupported()`, `getVADBrowserSupport()`, `logVADBrowserSupport()`.
- Ships a `react-server` exports-condition stub for RSC safety.

## Tuning tips

- VAD misses quiet speech: lower `positiveSpeechThreshold`, raise `preSpeechPadMs`.
- Too many false positives: raise `positiveSpeechThreshold` and `minSpeechMs`, and put `@arcaai/noise-filter` before VAD in the pipeline.
- Long multi-speaker sessions: keep the default `silenceResetMs` so the Silero LSTM state cannot drift.

## Commands

From this directory:

| Command | Action |
|---|---|
| `pnpm build` | tsup build; `pnpm build:e2e` also copies `dist/` into `e2e/fixtures/` |
| `pnpm test` / `pnpm test:watch` / `pnpm test:unit:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests; `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm clean:all` | Remove build output (nuke also removes `node_modules`) |

From the repo root: `pnpm --filter @arcaai/vad build` (same pattern for `test`, `lint`, etc.).

## License

MIT
