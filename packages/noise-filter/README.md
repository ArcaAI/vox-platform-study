# @arcaai/noise-filter — deprecated browser noise cancellation

`packages/noise-filter`, npm package `@arcaai/noise-filter` (version 3.5.0). **DEPRECATED**
(`package.json`'s `deprecated` field, TASK-865) — removed in R4. Client-side denoise is retired;
the tenant's ASR Agent runs denoise server-side. The browser captures audio and renders results;
it never runs a model. This package keeps building and stays importable until R4 so existing
hosts can migrate — do not add new consumers. Register row:
`docs/operations/deprecation-register.md` SDK section.

An AI-powered noise cancellation plugin for `@arcaai/room` (peer dependency). Runs RNNoise (a
hybrid DSP + deep-learning noise suppressor) as WebAssembly inside an AudioWorklet for real-time,
low-latency noise removal. The WASM binary ships inside the package — there is no runtime CDN
dependency. `react` is an optional peer dependency (only needed for `useNoiseFilter`). Consumed
as the first stage of `@arcaai/vox`'s `TranscriptionPipeline` (NoiseFilter -> VAD -> STT) prior
to deprecation.

## Layout

| Path | What it holds |
|---|---|
| `src/processors/` | `NoiseFilterProcessor` (+ `createNoiseFilter` factory), `RNNoiseProcessor` (low-level engine), worklet RNNoise loader |
| `src/worklets/` | `rnnoise.worklet.ts` (`AudioWorkletProcessor`) + registration helpers |
| `src/hooks/` | `useNoiseFilter` (React) |
| `src/types/` | `NoiseFilterOptions`, stats, worklet messages, errors |
| `src/wasmAsset.ts` | `getDefaultWasmUrl()` — resolves the bundled WASM binary |
| `assets/rnnoise.wasm` | Bundled RNNoise binary (synced from `@jitsi/rnnoise-wasm` at build) |
| `e2e/` | Playwright browser tests |

Subpath exports: `@arcaai/noise-filter/worklet` (the built AudioWorklet module) and
`@arcaai/noise-filter/wasm` (the `rnnoise.wasm` asset).

## Commands

Run from this directory, or `pnpm --filter @arcaai/noise-filter <script>` from the repo root.

| Command | Effect |
|---|---|
| `pnpm build` | tsup build (main bundle + worklet, syncs WASM asset) |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests; `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm nuke` | Remove build output (`nuke` also removes `node_modules`) |

## How it works

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
```

### Options (`NoiseFilterOptions`)

| Option | Default | Description |
|---|---|---|
| `noiseCancellation` | `true` | Enable RNNoise processing |
| `noiseCancellationLevel` | `'medium'` | Intensity: `'low' \| 'medium' \| 'high'` |
| `echoCancellation` | `true` | WebRTC-native echo cancellation on the source |
| `autoGainControl` | `true` | WebRTC-native AGC on the source |
| `wasmPath` | bundled asset | Override the RNNoise WASM URL (self-hosting) |
| `processingMode` | `'quality'` | `'quality' \| 'performance'` |
| `sampleRate` | `48000` | RNNoise operates at 48kHz |
| `enableStats` / `statsInterval` | `false` / `1000` | Emit `noise-stats` data events |

Key `NoiseFilterProcessor` methods: `setNoiseLevel(level)`, `getStats()`, `isUsingFallback()`,
`updateOptions(options)`, plus the inherited `enable()`/`disable()`/`destroy()` lifecycle.

Low-level exports: `RNNoiseProcessor`, `RNNOISE_FRAME_SIZE` (480 samples = 10ms at 48kHz),
`RNNOISE_SAMPLE_RATE` (48000), worklet helpers (`registerRNNoiseWorklet`,
`createRNNoiseWorkletNode`, `isWorkletRegistered`, `cleanupWorkletResources`,
`WORKLET_PROCESSOR_NAME`), and `getDefaultWasmUrl()`.

### WASM and worklet assets

- `assets/rnnoise.wasm` is copied from `@jitsi/rnnoise-wasm` during `pnpm build` (also into
  `dist/assets/`) and resolved at runtime via `new URL('../assets/rnnoise.wasm', import.meta.url)`
  — no CDN fetch is involved.
- The AudioWorklet module builds to `dist/worklets/rnnoise.worklet.js` (kept as `.js` because
  `audioWorklet.addModule` loads it by URL); also reachable via the `@arcaai/noise-filter/worklet`
  subpath export.
- Bundlers that understand `new URL(..., import.meta.url)` (Vite, webpack 5) pick both assets up
  automatically. To self-host manually, pass `wasmPath` in options.

### Runtime requirements and fallbacks

- Requires WebAssembly plus AudioWorklet.
- When AudioWorklet is unavailable, processing falls back to `ScriptProcessorNode`; if RNNoise
  itself cannot load, the processor falls back to WebRTC native noise suppression. Check with
  `isUsingFallback()` or `getNoiseFilterBrowserSupport()`.
- The RNNoise ring buffer is calibrated for 48kHz frame timing; other AudioContext rates produce
  audible artifacts — see the sample-rate enforcement section of
  [`../room/README.md`](../room/README.md).
- Browser-only; ships a `react-server` exports-condition stub for RSC safety.

## Gotchas

- **Worklet source is manually duplicated in three places — keep them in sync.** An
  `AudioWorkletProcessor` cannot `import` npm modules at runtime, so the RNNoise WASM glue is
  hand-ported into three copies that must stay algorithmically identical:
  1. `src/worklets/rnnoise.worklet.ts` — the TS `AudioWorkletProcessor`, built to
     `dist/worklets/rnnoise.worklet.js` and loaded by URL.
  2. `src/processors/workletRnnoiseLoader.ts` — the hand-port of the Emscripten runtime subset
     (`instantiateRnnoiseInWorklet`), pinned to the bundled `rnnoise.wasm` (v0.2.1) import object
     `{ a: { a: resize_heap, b: memcpy_big } }` and its single-letter export names (`c`-`j`).
  3. `src/worklets/worklet-loader.ts` — `generateWorkletSource()` returns the same logic
     re-embedded as an inline template-literal string for the runtime blob URL.

  All three encode: preallocated WASM I/O pointers, the exact import object above with exports
  addressed by minified names, and a two-frame ring buffer with one-frame priming latency. The
  single-letter export names and import-object shape are a hard dependency on
  `@jitsi/rnnoise-wasm@0.2.1` — bumping that dependency can silently break all three.

  **No drift test guards this.** `src/__tests__/workletLoader.test.ts` only asserts the loader's
  exports exist and that registration fails gracefully; it does not compare the inline blob
  string in `worklet-loader.ts` against the two source-of-truth files, so an edit to one copy not
  mirrored to the others passes CI and fails only at runtime in the browser. Until unified into a
  single source, edit all three together.

## Related

- [`@arcaai/room`](../room/README.md) — the `BaseProcessor`/`AudioTrack` contract this package
  implements, including sample-rate enforcement.
- [`assets/README.md`](assets/README.md) — the bundled WASM binary.
- `.claude/rules/08-vox-sdk.md` — the owner directive that the browser never runs a model.
