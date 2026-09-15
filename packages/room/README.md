# @arcaai/room — browser audio capture foundation

`packages/room`, npm package `@arcaai/room` (version 3.5.0). Browser microphone capture (`Room`,
`AudioTrack`), a shared `AudioContext` manager, a chainable processor pipeline, and React
hooks/components on top. Every audio plugin in this monorepo builds on the `BaseProcessor` /
`TrackProcessor` contract defined here. Runtime dependency: `eventemitter3`. Peer dependency:
`react` `^18.3.0 || ^19.0.4`.

Consumed by `@arcaai/vox` (`packages/agentic-sdk-v2`), whose `TranscriptionPipeline` wires
processors onto room tracks, and by `@arcaai/med-ner` type-only. `@arcaai/noise-filter` and
`@arcaai/vad` implement `BaseProcessor` against this package but are deprecated for removal (see
[The browser never runs a model](#the-browser-never-runs-a-model)); `@arcaai/stt`'s in-browser
processor is likewise deprecated, though the package's PCM capture helpers are not.

## Layout

| Path | What it holds |
|---|---|
| `src/core/` | `Room`, `AudioTrack`, `AudioContextManager`, `ProcessorPipeline`, `AudioMixer`, typed `RoomErrors` |
| `src/processors/` | `BaseProcessor`, `BaseTextProcessor`, `NativeProcessor`, the `TrackProcessor` interface |
| `src/components/` | `RoomProvider`, `AudioTrackRenderer` |
| `src/hooks/` | `useRoom`, `useAudioTrack`, `useAudioLevel`, `useDevices`, `useProcessors`, `useAudioMixer`, `useBrowserCapabilities` |
| `src/events/` | `TypedEventEmitter`, `TrackEvent`, `ProcessorEvent` maps |
| `src/types/` | `AudioFeature`, `TrackState`, `RoomOptions`, `RoomError` |
| `src/utils/` | Browser support/compat, constraints, worklet loader, audio level math, debug logger |
| `src/index.ts` | Public barrel export |
| `src/react-server-stub.ts` | Served under the `react-server` exports condition |
| `e2e/` | Playwright browser tests (fixtures + specs) |

## Commands

Run from this directory, or `pnpm --filter @arcaai/room <script>` from the repo root.

| Command | Effect |
|---|---|
| `pnpm build` | tsup build (ESM `.mjs` + CJS `.cjs` + types) |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests (`e2e/`); `:headed`, `:debug`, `:chromium`, `:firefox`, `:webkit` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm nuke` | Remove build output (`nuke` also removes `node_modules`) |

## How it works

### React usage

```tsx
import { RoomProvider, useAudioTrack, useAudioLevel } from '@arcaai/room';

function App() {
  return (
    <RoomProvider>
      <AudioRecorder />
    </RoomProvider>
  );
}

function AudioRecorder() {
  const { track, isCapturing, startCapture, stopCapture } = useAudioTrack({
    noiseSuppression: true,
    echoCancellation: true,
  });
  const { level, isSpeaking } = useAudioLevel(track);

  return (
    <div>
      <button onClick={isCapturing ? stopCapture : startCapture}>{isCapturing ? 'Stop' : 'Start'}</button>
      <div>Level: {(level * 100).toFixed(0)}%</div>
      <div>Speaking: {isSpeaking ? 'Yes' : 'No'}</div>
    </div>
  );
}
```

`noiseSuppression`/`echoCancellation` here are native `getUserMedia` constraints handled by the
browser/OS — not a model this package loads. See
[The browser never runs a model](#the-browser-never-runs-a-model).

### Key exports

| Group | Exports |
|---|---|
| Core classes | `Room`, `AudioTrack`, `AudioContextManager`, `ProcessorPipeline`, `AudioMixer` |
| Processors | `BaseProcessor`, `BaseTextProcessor`, `NativeProcessor`, `TrackProcessor` (interface) |
| Components | `RoomProvider`, `AudioTrackRenderer` |
| Hooks | `useRoom`, `useRoomSafe`, `useAudioTrack`, `useAudioLevel`, `useMediaStreamAudioLevel`, `useDevices`, `useProcessors`, `useAudioMixer`, `useBrowserCapabilities` |
| Events | `TrackEvent`, `ProcessorEvent`, `TypedEventEmitter` |
| Errors | `RoomError`, `RoomPermissionError`, `RoomDeviceError`, `RoomSampleRateMismatchError`, `mapGetUserMediaError` |

`AudioMixer` merges multiple `MediaStream` inputs into one output via Web Audio `GainNode`
summation with `1/sqrt(N)` master-gain normalization; pair it with `useAudioMixer`.

### Writing a processor plugin

Custom audio stages implement `TrackProcessor` or extend `BaseProcessor` (adds lifecycle, event
emission, a `protected debugMode` flag):

```typescript
import { BaseProcessor, type AudioProcessorOptions } from '@arcaai/room';

class MyProcessor extends BaseProcessor {
  constructor(debugMode?: boolean) {
    super('my-processor', debugMode);
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;
    // build your Web Audio graph, then set this.processedTrack
  }

  protected async onDestroy(): Promise<void> {
    // release nodes
  }
}
```

Chain several with `ProcessorPipeline`:

```typescript
const pipeline = new ProcessorPipeline([noiseFilter, vad, stt]);
await audioTrack.setProcessor(pipeline);
await pipeline.setEnabled('vad-processor', false);
```

### Sample-rate enforcement

Downstream processors are sample-rate sensitive: RNNoise (`@arcaai/noise-filter`) requires
48000 Hz; Silero VAD resamples internally to 16000 Hz. macOS commonly locks devices to
44100 Hz, which silently degrades RNNoise quality. `AudioContextManager.acquire(opts)` supports
opt-in enforcement:

| `requireSampleRate` | `allowMismatch` | Behavior on mismatch |
|---|---|---|
| unset | - | no-op (backwards-compatible default) |
| `48000` | `false` (default) | throws `RoomSampleRateMismatchError` (`code: 'sample_rate_mismatch'`) |
| `48000` | `true` | logs a `console.warn` and resolves with the context |

### The browser never runs a model

`@arcaai/room` itself never runs a model — it is pure capture and Web Audio plumbing. The
deprecated downstream processors (`@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt`'s local
Whisper, `@arcaai/med-ner`) that attach to it via `TrackProcessor` are retired by owner directive
(TASK-865): VAD, denoise, diarization, ASR and NER are server-side decisions of the tenant's
Agents. Native `getUserMedia` constraints (`noiseSuppression`, `echoCancellation`,
`autoGainControl`) are not models and stay on by default.

### Runtime requirements

- Browser only. Microphone capture requires a secure context (HTTPS or localhost) and the user
  granting `getUserMedia` permission; failures map to typed errors via `mapGetUserMediaError`.
- AudioWorklet is used where available; check at runtime with `getBrowserSupport()` /
  `isAdvancedAudioSupported()`.
- React Server Components: the package ships a `react-server` exports-condition stub, so
  importing it in an RSC context fails loudly instead of executing browser code. All real entry
  points carry `"use client"`.

## Related

- [`@arcaai/vox`](../agentic-sdk-v2/README.md) — the browser SDK that wires this package's tracks
  into its capture graph.
- [`@arcaai/noise-filter`](../noise-filter/README.md), [`@arcaai/vad`](../vad/README.md),
  [`@arcaai/stt`](../stt/README.md), [`@arcaai/med-ner`](../med-ner/README.md) — deprecated
  processor implementations built on this package.
- `.claude/rules/08-vox-sdk.md` — the owner directive that the browser never runs a model.
