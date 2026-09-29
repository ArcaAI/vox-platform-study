# @arcaai/room — browser audio capture foundation

`packages/room`, npm package `@arcaai/room` (version 4.0.x). Browser microphone capture (`Room`,
`AudioTrack`), a shared `AudioContext` manager, a chainable processor pipeline, and React
hooks/components on top. Any Web Audio stage attaches through the `BaseProcessor` /
`TrackProcessor` contract defined here. Runtime dependency: `eventemitter3`. Peer dependency:
`react` `^18.3.0 || ^19.0.4`.

Consumed by `@arcaai/vox` (`packages/agentic-sdk-v2`), whose `TranscriptionPipeline` wires room
tracks into the backend streaming STT transport, and by `@arcaai/stt` (PCM capture helpers + that
transport). The model-running processors that used to build on it — `@arcaai/noise-filter`,
`@arcaai/vad`, `@arcaai/med-ner` and `@arcaai/stt`'s in-browser Whisper — were deleted in 4.0.0
(TASK-1006; see [The browser never runs a model](#the-browser-never-runs-a-model)).

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
// Your own Web Audio stages — e.g. a gain stage and a level meter (never a model).
const pipeline = new ProcessorPipeline([gainStage, levelMeter]);
await audioTrack.setProcessor(pipeline);
await pipeline.setEnabled('level-meter', false);
```

### Sample-rate enforcement

Some processors are sample-rate sensitive (the enforcement below was added for the RNNoise
processor, which required 48000 Hz and was deleted in 4.0.0). macOS commonly locks devices to
44100 Hz, which a fixed-rate stage would silently mishandle. `AudioContextManager.acquire(opts)`
supports opt-in enforcement:

| `requireSampleRate` | `allowMismatch` | Behavior on mismatch |
|---|---|---|
| unset | - | no-op (backwards-compatible default) |
| `48000` | `false` (default) | throws `RoomSampleRateMismatchError` (`code: 'sample_rate_mismatch'`) |
| `48000` | `true` | logs a `console.warn` and resolves with the context |

### The browser never runs a model

`@arcaai/room` itself never runs a model — it is pure capture and Web Audio plumbing. The
downstream processors that did (`@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt`'s local
Whisper, `@arcaai/med-ner`) were retired by owner directive (TASK-865) and deleted in 4.0.0
(TASK-1006): VAD, denoise, diarization, ASR and NER are server-side decisions of the tenant's
Agents, selected by `agentSlug` or by the gateway — never by the browser. Native `getUserMedia` constraints (`noiseSuppression`, `echoCancellation`,
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
- [`@arcaai/stt`](../stt/README.md) — PCM capture helpers and the backend streaming STT transport
  built on this package. (`@arcaai/noise-filter`, `@arcaai/vad` and `@arcaai/med-ner` were
  deleted in 4.0.0.)
- `.claude/rules/08-vox-sdk.md` — the owner directive that the browser never runs a model.
