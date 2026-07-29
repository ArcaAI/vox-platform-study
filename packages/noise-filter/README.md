# @arcaai/noise-filter

AI-powered noise cancellation plugin for `@arcaai/room`. Runs RNNoise (a hybrid DSP + deep-learning noise suppressor) as WebAssembly inside an AudioWorklet for real-time, low-latency noise removal in the browser. The WASM binary ships inside the package — there is no runtime CDN dependency.

Last updated: 2026-07-04

## Where it fits

| Direction   | Package                         | Relationship                                                     |
| ----------- | ------------------------------- | ---------------------------------------------------------------- |
| Depends on  | `@arcaai/room` (peer, `^0.1.0`) | Extends `BaseProcessor`; attaches to an `AudioTrack`             |
| Depends on  | `@jitsi/rnnoise-wasm`           | Source of the `rnnoise.wasm` binary (copied at build time)       |
| Consumed by | `@arcaai/vox`                   | First stage of `TranscriptionPipeline` (NoiseFilter → VAD → STT) |

`react` is an optional peer dependency (only needed for the `useNoiseFilter` hook).

## Directory structure

```
packages/noise-filter/
├── src/
│   ├── processors/     # NoiseFilterProcessor (+ createNoiseFilter factory),
│   │                   # RNNoiseProcessor (low-level engine), worklet RNNoise loader
│   ├── worklets/       # rnnoise.worklet.ts (AudioWorkletProcessor) + registration helpers
│   ├── hooks/          # useNoiseFilter (React)
│   ├── types/          # NoiseFilterOptions, stats, worklet messages, errors
│   ├── utils/          # Browser support detection
│   ├── wasmAsset.ts    # getDefaultWasmUrl() — resolves the bundled WASM binary
│   └── index.ts        # Public barrel export
├── assets/rnnoise.wasm # Bundled RNNoise binary (synced from @jitsi/rnnoise-wasm at build)
├── e2e/                # Playwright browser tests
└── tsup.config.ts      # Main bundle + worklet bundle (dist/worklets/rnnoise.worklet.js)
```

Subpath exports: `@arcaai/noise-filter/worklet` (the built AudioWorklet module) and `@arcaai/noise-filter/wasm` (the `rnnoise.wasm` asset).

## Public API overview

### React hook

```tsx
import { useAudioTrack } from '@arcaai/room';
import { useNoiseFilter } from '@arcaai/noise-filter';

function AudioRecorder() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: false, // disable native NS — RNNoise replaces it
    echoCancellation: true,
  });

  const { isEnabled, noiseLevel, noiseReductionDb, toggle, setLevel, error } = useNoiseFilter({
    track,
    noiseCancellation: true,
    noiseCancellationLevel: 'high',
    autoAttach: true,
    enableStats: true,
  });

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>{isCapturing ? 'Stop' : 'Start Recording'}</button>
      <div>
        Filter: {isEnabled ? 'ON' : 'OFF'} ({noiseLevel})
      </div>
      <div>Noise reduction: {noiseReductionDb.toFixed(1)} dB</div>
      <button onClick={() => toggle()}>Toggle</button>
      {error && <div>{error.message}</div>}
    </div>
  );
}
```

### Processor usage

```typescript
import { AudioTrack, AudioContextManager } from '@arcaai/room';
import { createNoiseFilter } from '@arcaai/noise-filter';

const audioContext = await AudioContextManager.getInstance({ sampleRate: 48000 }).acquire();
const track = new AudioTrack({ audioContext });
await track.initialize({ noiseSuppression: false, echoCancellation: true });

const noiseFilter = createNoiseFilter({
  noiseCancellation: true,
  noiseCancellationLevel: 'medium',
  enableStats: true,
});
noiseFilter.on('data', (payload) => {
  if (payload.type === 'noise-stats') {
    console.log(payload.data.noiseReductionDb, 'dB', payload.data.vadProbability);
  }
});

await track.setProcessor(noiseFilter);
// track.mediaStreamTrack now carries noise-filtered audio
```

### Options (`NoiseFilterOptions`)

| Option                          | Default          | Description                                        |
| ------------------------------- | ---------------- | -------------------------------------------------- |
| `noiseCancellation`             | `true`           | Enable RNNoise processing                          |
| `noiseCancellationLevel`        | `'medium'`       | Intensity: `'low' \| 'medium' \| 'high'`           |
| `echoCancellation`              | `true`           | WebRTC-native echo cancellation on the source      |
| `autoGainControl`               | `true`           | WebRTC-native AGC on the source                    |
| `wasmPath`                      | bundled asset    | Override the RNNoise WASM URL (self-hosting)       |
| `processingMode`                | `'quality'`      | `'quality' \| 'performance'`                       |
| `sampleRate`                    | `48000`          | RNNoise operates at 48 kHz                         |
| `enableStats` / `statsInterval` | `false` / `1000` | Emit `noise-stats` data events                     |
| `debugMode`                     | `false`          | Log configuration with the `[ARCAAI:DEBUG]` prefix |

Key `NoiseFilterProcessor` methods: `setNoiseLevel(level)`, `getNoiseLevel()`, `getStats()`, `isUsingFallback()`, `updateOptions(options)`, plus the inherited `enable()` / `disable()` / `destroy()` lifecycle.

Low-level exports: `RNNoiseProcessor`, `RNNOISE_FRAME_SIZE` (480 samples = 10 ms at 48 kHz), `RNNOISE_SAMPLE_RATE` (48000), worklet helpers (`registerRNNoiseWorklet`, `createRNNoiseWorkletNode`, `isWorkletRegistered`, `cleanupWorkletResources`, `WORKLET_PROCESSOR_NAME`), and `getDefaultWasmUrl()`.

## WASM and worklet assets

- The `rnnoise.wasm` binary is copied from `@jitsi/rnnoise-wasm` into `assets/rnnoise.wasm` (and `dist/assets/`) during `pnpm build`, and resolved at runtime via `new URL('../assets/rnnoise.wasm', import.meta.url)`. No CDN fetch is involved.
- The AudioWorklet module builds to `dist/worklets/rnnoise.worklet.js` (kept as `.js` because `audioWorklet.addModule` loads it by URL). It is also reachable via the `@arcaai/noise-filter/worklet` subpath export.
- Bundlers that understand `new URL(..., import.meta.url)` (Vite, webpack 5) pick both assets up automatically. To self-host manually, pass `wasmPath` in options.

### Worklet source is manually duplicated in THREE places — keep them in sync

An `AudioWorkletProcessor` cannot `import` npm modules at runtime, so the RNNoise WASM glue is hand-ported and the same processor logic exists in three copies that MUST stay algorithmically identical:

1. `src/worklets/rnnoise.worklet.ts` — the TS `AudioWorkletProcessor` (built to `dist/worklets/rnnoise.worklet.js`, loaded by URL).
2. `src/processors/workletRnnoiseLoader.ts` — the hand-port of the Emscripten runtime subset (`instantiateRnnoiseInWorklet`), pinned to the bundled `rnnoise.wasm` (v0.2.1) import object `{ a: { a: resize_heap, b: memcpy_big } }` and its single-letter export names (`c`–`j`).
3. `src/worklets/worklet-loader.ts` — `generateWorkletSource()` returns the SAME logic re-embedded as an inline template-literal string for the runtime blob URL.

Invariants all three encode: preallocated WASM I/O pointers, the exact import object above with exports addressed by minified names, and a two-frame ring buffer with one-frame priming latency. The single-letter export names and the import-object shape are a hard dependency on `@jitsi/rnnoise-wasm@0.2.1` — bumping that dependency can silently break all three.

**No drift test guards this.** `src/__tests__/workletLoader.test.ts` only asserts the loader's exports exist and that registration fails gracefully; it does NOT compare the inline blob string in `worklet-loader.ts` against the two source-of-truth files, so an edit to one copy that is not mirrored to the others will pass CI and fail only at runtime in the browser. Unifying the source into a single file is the intended fix (deferred). Until then, edit all three together, or add a test that diffs the normalized inline source against the built worklet.

## Runtime requirements and fallbacks

- Requires WebAssembly plus AudioWorklet (Chrome 66+, Firefox 76+, Safari 17.4+, Edge 79+).
- When AudioWorklet is unavailable, processing falls back to `ScriptProcessorNode`; if RNNoise itself cannot load, the processor falls back to WebRTC native noise suppression. Check with `isUsingFallback()` or `getNoiseFilterBrowserSupport()`.
- The RNNoise ring buffer is calibrated for 48 kHz frame timing; other AudioContext rates produce audible artefacts. See the sample-rate enforcement section of the `@arcaai/room` README (`../room/README.md`).
- Browser-only; the package ships a `react-server` exports-condition stub for RSC safety.

## Commands

From this directory:

| Command                                                | Action                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `pnpm build`                                           | tsup build (main bundle + worklet, syncs WASM asset)                   |
| `pnpm test` / `pnpm test:watch` / `pnpm test:unit:cov` | Vitest unit tests                                                      |
| `pnpm test:e2e`                                        | Playwright browser tests; `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint`                                            | ESLint (`--max-warnings 0`)                                            |
| `pnpm typecheck`                                       | `tsc --noEmit`                                                         |
| `pnpm clean` / `pnpm clean:all`                        | Remove build output (nuke also removes `node_modules`)                 |

From the repo root: `pnpm --filter @arcaai/noise-filter build` (same pattern for `test`, `lint`, etc.).

## License

MIT
