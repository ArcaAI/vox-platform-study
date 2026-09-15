# @arcaai/vad — deprecated browser voice-activity detection

`packages/vad`, npm package `@arcaai/vad` (version 3.5.0). **DEPRECATED** (`package.json`'s
`deprecated` field, TASK-865) — removed in R4. Client-side VAD is retired; the tenant's ASR Agent
runs VAD server-side. The browser captures audio and renders results; it never runs a model. This
package keeps building and stays importable until R4 so existing hosts can migrate — do not add
new consumers. Register row: `docs/operations/deprecation-register.md` SDK section.

A Voice Activity Detection plugin for `@arcaai/room` (peer dependency) built on Silero VAD (v5 or
legacy) via `@ricky0123/vad-web` and ONNX Runtime WebAssembly. Detects speech in real time, emits
speech start/end events with the captured audio segment, and exposes both a `VADProcessor` class
and a `useVAD` React hook. `react` is an optional peer dependency (only needed for `useVAD`).
Consumed as the middle stage of `@arcaai/vox`'s `TranscriptionPipeline` (NoiseFilter -> VAD ->
STT) prior to deprecation.

## Layout

| Path | What it holds |
|---|---|
| `src/processors/` | `VADProcessor` (+ `createVAD` factory) wrapping `MicVAD` |
| `src/hooks/` | `useVAD` (React) |
| `src/utils/` | Browser support, 16kHz resampler, `FrameAccumulator`/`AudioRingBuffer` |
| `src/types/` | `VADOptions`, `VADStats`, event payloads, `VADError` |
| `src/constants.ts` | Pinned CDN versions (`VAD_WEB_VERSION`, `ORT_WEB_VERSION`) + default asset paths |
| `examples/` | `basic-usage.tsx`, `transcription-integration.ts` |
| `assets/README.md` | Model notes — ONNX models load from `vad-web`/CDN or a self-hosted path, nothing is bundled here |
| `e2e/` | Playwright browser tests |

## Commands

Run from this directory, or `pnpm --filter @arcaai/vad <script>` from the repo root.

| Command | Effect |
|---|---|
| `pnpm build` | tsup build; `pnpm build:e2e` also copies `dist/` into `e2e/fixtures/` |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests (runs `build:e2e` first); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm nuke` | Remove build output (`nuke` also removes `node_modules`) |

## How it works

### Processor usage

```typescript
import { createVAD } from '@arcaai/vad';

const vad = createVAD({ model: 'v5', positiveSpeechThreshold: 0.5 });

vad.on('data', (payload) => {
  switch (payload.type) {
    case 'vad-speech-start': // speech onset detected
    case 'vad-speech-real-start': // confirmed (exceeded minSpeechMs)
      break;
    case 'vad-speech-end':
      // payload.data.audio: Float32Array @ 16 kHz, plus segment timing metadata
      break;
    case 'vad-misfire': // segment shorter than minSpeechMs
    case 'vad-frame': // per-frame probability
    case 'vad-stats': // when enableStats: true
      break;
  }
});

await audioTrack.setProcessor(vad);
```

Full runnable versions: `examples/basic-usage.tsx`, `examples/transcription-integration.ts`.

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
| `sampleRate` | `16000` | Output rate for speech-end audio (model always runs at 16kHz) |
| `baseAssetPath` / `onnxWASMBasePath` | pinned jsDelivr CDN | Self-host the vad-web assets / ORT WASM binaries |
| `submitUserSpeechOnPause` | `false` | Emit the in-flight segment when pausing |
| `enableStats` / `statsInterval` | `false` / `1000` | Emit `vad-stats` data events |

Key `VADProcessor` methods: `isSpeaking()`, `getSpeechProbability()`, `getStats()`, `getModel()`,
`updateOptions(options)`, `updateThresholds(pos, neg)`, `pause()`, `start()`,
`reset()` (force-rebuild MicVAD/LSTM state), plus inherited `enable()`/`disable()`/`destroy()`.

### Model assets and version pinning

ONNX models and the vad-web worklet are not bundled. By default they load from jsDelivr using
version-pinned URLs derived from `VAD_WEB_VERSION` (`0.0.30`) and `ORT_WEB_VERSION` (`1.27.0`) in
`src/constants.ts`. These must match `package.json`'s `@ricky0123/vad-web` dependency version — a
unit test enforces the invariant, because the ONNX Runtime WASM ABI is not stable across minor
versions. For production, prefer self-hosting: copy the `@ricky0123/vad-web` dist assets and
`onnxruntime-web` WASM binaries to your server and set `baseAssetPath`/`onnxWASMBasePath`.

### Runtime requirements

- Browser only: WebAssembly + AudioWorklet. Older Safari/iOS can use `model: 'legacy'`;
  `getRecommendedModel()` picks one automatically.
- Microphone permission is handled by the `@arcaai/room` track you attach to.
- Multi-threaded ONNX Runtime requires cross-origin isolation (COOP/COEP headers,
  `window.crossOriginIsolated === true`); without it, inference silently runs single-threaded —
  same gating as `@arcaai/stt`.
- Support probing: `isVADSupported()`, `getVADBrowserSupport()`, `logVADBrowserSupport()`.
- Ships a `react-server` exports-condition stub for RSC safety.

### Tuning tips

- VAD misses quiet speech: lower `positiveSpeechThreshold`, raise `preSpeechPadMs`.
- Too many false positives: raise `positiveSpeechThreshold` and `minSpeechMs`, and put
  `@arcaai/noise-filter` before VAD in the pipeline.
- Long multi-speaker sessions: keep the default `silenceResetMs` so the Silero LSTM state cannot
  drift.

## Related

- [`@arcaai/room`](../room/README.md) — the `BaseProcessor`/`AudioTrack` contract this package
  implements.
- [`@arcaai/stt`](../stt/README.md) — shares the COOP/COEP cross-origin-isolation requirement.
- [`assets/README.md`](assets/README.md) — model notes.
- `.claude/rules/08-vox-sdk.md` — the owner directive that the browser never runs a model.
