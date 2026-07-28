# @arcaai/room

Browser audio capture and processing foundation for the ARCAAI audio stack. Provides microphone capture (`Room`, `AudioTrack`), a shared `AudioContext` manager, a chainable processor pipeline, and React hooks/components on top. Every audio plugin in this monorepo (`@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt`, `@arcaai/med-ner`) builds on the `BaseProcessor` / `TrackProcessor` contract defined here.

Last updated: 2026-07-04

## Where it fits

| Direction   | Package                                              | Relationship                                              |
| ----------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Consumed by | `@arcaai/noise-filter`, `@arcaai/vad`, `@arcaai/stt` | Implement `BaseProcessor` and attach to an `AudioTrack`   |
| Consumed by | `@arcaai/med-ner`                                    | Type-only (`TrackProcessor`, `ProcessorOptions`)          |
| Consumed by | `@arcaai/vox` (`packages/agentic-sdk-v2`)            | `TranscriptionPipeline` wires processors onto room tracks |
| Consumed by | `apps/ui-playground` (deprecated)                    | Via `@arcaai/vox`                                         |

Runtime dependency: `eventemitter3`. Peer dependency: `react` `^18.3.0 || ^19.0.4`.

## Directory structure

```
packages/room/
├── src/
│   ├── core/          # Room, AudioTrack, AudioContextManager, ProcessorPipeline,
│   │                  # AudioMixer, typed Room errors (RoomErrors.ts)
│   ├── processors/    # BaseProcessor, BaseTextProcessor, NativeProcessor,
│   │                  # TrackProcessor interface + processor types
│   ├── components/    # RoomProvider, AudioTrackRenderer
│   ├── hooks/         # useRoom, useAudioTrack, useAudioLevel, useDevices,
│   │                  # useProcessors, useAudioMixer, useBrowserCapabilities
│   ├── events/        # TypedEventEmitter, TrackEvent, ProcessorEvent maps
│   ├── types/         # AudioFeature, TrackState, RoomOptions, RoomError
│   ├── utils/         # browser support/compat, constraints, worklet loader,
│   │                  # audio level math, debug logger
│   ├── __tests__/     # Vitest unit tests
│   ├── index.ts       # Public barrel export
│   └── react-server-stub.ts  # Served under the "react-server" exports condition
├── e2e/               # Playwright browser tests (fixtures + specs)
└── tsup.config.ts     # ESM (.mjs) + CJS (.cjs) build
```

## Public API overview

### React usage (from `src/index.ts`)

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

### Imperative usage

```typescript
import { Room, AudioFeature } from '@arcaai/room';

const room = new Room({ webAudioMix: true });
await room.connect(); // initializes the AudioContext

const track = await room.createLocalTrack({
  noiseSuppression: true,
  echoCancellation: true,
});

await track.setFeature(AudioFeature.NOISE_SUPPRESSION, false);
track.on('audioLevelUpdate', (info) => console.log(info.level, info.isSpeaking));

await room.disconnect();
```

### Key exports

| Group        | Exports                                                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core classes | `Room`, `AudioTrack`, `AudioContextManager`, `ProcessorPipeline`, `AudioMixer`                                                                                      |
| Processors   | `BaseProcessor`, `BaseTextProcessor`, `NativeProcessor`, `TrackProcessor` (interface)                                                                               |
| Components   | `RoomProvider`, `AudioTrackRenderer`                                                                                                                                |
| Hooks        | `useRoom`, `useRoomSafe`, `useAudioTrack`, `useAudioLevel`, `useMediaStreamAudioLevel`, `useDevices`, `useProcessors`, `useAudioMixer`, `useBrowserCapabilities`    |
| Events       | `TrackEvent`, `ProcessorEvent`, `TypedEventEmitter`                                                                                                                 |
| Errors       | `RoomError`, `RoomPermissionError`, `RoomDeviceError`, `RoomSampleRateMismatchError`, `mapGetUserMediaError`, ...                                                   |
| Utils        | `getBrowserSupport`, `getBrowserCapabilities`, `buildAudioConstraints`, `createWorkletLoader`, `debugLog`, `debugLogConfig`, `debugLogTranscript`, audio level math |

`AudioMixer` merges multiple `MediaStream` inputs into one output via Web Audio `GainNode` summation with `1/sqrt(N)` master-gain normalization; pair it with `useAudioMixer`.

## Writing a processor plugin

Custom audio stages implement `TrackProcessor` or extend `BaseProcessor` (which adds lifecycle, event emission, and a `protected debugMode` flag):

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

Chain several processors with `ProcessorPipeline`:

```typescript
const pipeline = new ProcessorPipeline([noiseFilter, vad, stt]);
await audioTrack.setProcessor(pipeline);
await pipeline.setEnabled('vad-processor', false);
```

Real implementations to reference: `NoiseFilterProcessor` (`packages/noise-filter`), `VADProcessor` (`packages/vad`), `STTProcessor` (`packages/stt`).

## Sample-rate enforcement

Downstream processors are sample-rate sensitive: RNNoise (`@arcaai/noise-filter`) requires 48 000 Hz; Silero VAD resamples internally to 16 000 Hz. macOS commonly locks devices to 44 100 Hz, which silently degrades RNNoise quality. `AudioContextManager.acquire(opts)` supports opt-in enforcement:

```typescript
import { AudioContextManager, RoomSampleRateMismatchError } from '@arcaai/room';

const manager = AudioContextManager.getInstance({ sampleRate: 48000 });
try {
  await manager.acquire({ requireSampleRate: 48000 });
} catch (err) {
  if (err instanceof RoomSampleRateMismatchError) {
    // accept the mismatch explicitly, or fall back to device-default processors
    await manager.acquire({ requireSampleRate: 48000, allowMismatch: true });
  }
}
```

| `requireSampleRate` | `allowMismatch`   | Behaviour on mismatch                                                 |
| ------------------- | ----------------- | --------------------------------------------------------------------- |
| unset               | —                 | no-op (backwards-compatible default)                                  |
| `48000`             | `false` (default) | throws `RoomSampleRateMismatchError` (`code: 'sample_rate_mismatch'`) |
| `48000`             | `true`            | logs a `console.warn` and resolves with the context                   |

## Runtime requirements

- Browser only. Microphone capture requires a secure context (HTTPS or localhost) and the user granting `getUserMedia` permission; failures map to typed errors via `mapGetUserMediaError`.
- AudioWorklet is used where available (Chrome 66+, Firefox 76+, Safari 17.4+, Edge 79+); older Safari falls back where possible. Check at runtime with `getBrowserSupport()` / `isAdvancedAudioSupported()`.
- React Server Components: the package ships a `react-server` exports-condition stub, so importing it in an RSC context fails loudly instead of executing browser code. All real entry points carry `"use client"`.

## Commands

From this directory:

| Command                                                | Action                                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `pnpm build`                                           | tsup build (ESM `.mjs` + CJS `.cjs` + types)                                                              |
| `pnpm test` / `pnpm test:watch` / `pnpm test:unit:cov` | Vitest unit tests                                                                                         |
| `pnpm test:e2e`                                        | Playwright browser tests (`e2e/`); `:headed`, `:debug`, `:chromium`, `:firefox`, `:webkit` variants exist |
| `pnpm lint`                                            | ESLint (`--max-warnings 0`)                                                                               |
| `pnpm typecheck`                                       | `tsc --noEmit`                                                                                            |
| `pnpm clean` / `pnpm clean:all`                        | Remove build output (nuke also removes `node_modules`)                                                    |

From the repo root: `pnpm --filter @arcaai/room build` (same pattern for `test`, `lint`, etc.).

## License

MIT
