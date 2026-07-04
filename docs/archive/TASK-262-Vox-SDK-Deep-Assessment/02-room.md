---

# `@arcaai/room` — Exhaustive Code Review

**Reviewed:** `packages/room/src/` (all files), `packages/room/README.md`, `packages/room/src/__tests__/` (all), `packages/room/e2e/room.e2e.spec.ts`
**Date:** 2026-05-23

---

## 1. Architecture

### 1.1 AudioContext Lifecycle

The singleton `AudioContextManager` (`src/core/AudioContextManager.ts`) owns the one shared `AudioContext`. It uses a reference-count (`referenceCount`) so multiple `Room` instances (or the `useAudioMixer` hook) can share it:

- `acquire()` → increments count, creates/resumes context.
- `release()` → decrements count, closes when count reaches 0 (skipped for custom contexts).
- `dispose()` → hard-reset (forced close, count→0).

`Room.connect()` calls `contextManager.acquire()` and `Room.disconnect()` calls `contextManager.release()`. The singleton is reset in tests via `AudioContextManager.resetInstance()`.

**No ScriptProcessorNode fallback exists.** There is no `createScriptProcessor` path in any production code—only in mock factories inside tests.

### 1.2 Sample Rates

| Consumer | Required rate | How it gets this rate |
|---|---|---|
| Whisper / `@arcaai/stt` | 16 kHz | Downstream resampling (`resampleAudio` in `audioUtils.ts:137`) |
| RNNoise / `@arcaai/noise-filter` | 48 kHz | Browser default or via constraint |
| Silero VAD / `@arcaai/vad` | 16 kHz | Downstream resampling |

The `AudioContext` is created with no `sampleRate` override by default (`DEFAULT_ROOM_OPTIONS` has `sampleRate: undefined`, `types/index.ts:157`). The actual sample rate is left to the browser (typically 48 kHz on desktop, 44.1 kHz on some iOS hardware). There is **no enforcement** that the context runs at a specific rate, and no runtime assertion when a plugin expects 16 kHz.

`resampleAudio` (`audioUtils.ts:137-155`) uses naive linear interpolation — adequate for a modest ratio like 48 kHz → 16 kHz but audibly inferior to sinc/polyphase resampling. For Whisper/Silero this is a quality concern, not a correctness blocker.

### 1.3 Processor Chain Model

```
getUserMedia ──► sourceTrack ──► [Processor 0] ──► [Processor 1] ──► … ──► processedTrack
                                    (e.g. noise)        (e.g. VAD)
```

`ProcessorPipeline.buildPipeline()` calls each processor's `init()` in priority order, threading `currentTrack` through each `processedTrack`. The pipeline itself implements `TrackProcessor`, so it plugs into `AudioTrack.setProcessor()`. `AudioTrack` holds exactly one processor slot, so the pipeline is the only way to chain plugins.

**Plugin contract** (`src/processors/types.ts`):

```
init(opts: AudioProcessorOptions): Promise<void>
restart(opts: AudioProcessorOptions): Promise<void>
destroy(): Promise<void>
onAttach?(), onDetach?(), enable?(), disable?(), isEnabled?(), isSupported?()
processedTrack?: MediaStreamTrack
```

`opts.audioContext` and `opts.track` are passed in on every `init`. Plugins create their own Web Audio graph inside `onInit`, expose a `MediaStreamTrack` via `processedTrack`, and release all nodes in `onDestroy`.

---

## 2. Public API Surface

| Export | Category | Source |
|---|---|---|
| `AudioFeature` (enum) | Types | `types/index.ts:15` |
| `AudioCaptureOptions` | Types | `types/index.ts:29` |
| `DEFAULT_AUDIO_OPTIONS` | Types | `types/index.ts:51` |
| `TrackState` (enum) | Types | `types/index.ts:66` |
| `TrackKind` | Types | `types/index.ts:84` |
| `TrackSource` (enum) | Types | `types/index.ts:89` |
| `AudioDevice` | Types | `types/index.ts:105` |
| `AudioLevelInfo` | Types | `types/index.ts:125` |
| `RoomOptions` | Types | `types/index.ts:143` |
| `DEFAULT_ROOM_OPTIONS` | Types | `types/index.ts:157` |
| `BrowserSupport` | Types | `types/index.ts:169` |
| `BrowserCapabilities` | Types | `types/index.ts:200` |
| `BrowserLimitation` | Types | `types/index.ts:218` |
| `BrowserName` | Types | `types/index.ts:195` |
| `RoomErrorCode` (enum) | Types | `types/index.ts:232` |
| `RoomError` | Types | `types/index.ts:254` |
| `EventCallback` | Types | `types/index.ts:272` |
| `InitResult` | Types | `types/index.ts:277` |
| `Disposable` | Types | `types/index.ts:285` |
| `AudioContextManager` | Core | `core/AudioContextManager.ts` |
| `getNewAudioContext` | Core | `core/AudioContextManager.ts:327` |
| `AudioTrack` | Core | `core/AudioTrack.ts` |
| `AudioTrackOptions` | Core | `core/AudioTrack.ts:48` |
| `ProcessorPipeline` | Core | `core/ProcessorPipeline.ts` |
| `Room` | Core | `core/Room.ts` |
| `RoomEvent` (enum) | Core | `core/Room.ts:22` |
| `RoomState` (enum) | Core | `core/Room.ts:56` |
| `RoomEventMap` | Core | `core/Room.ts:40` |
| `createLocalTracks` | Core | `core/Room.ts:331` |
| `AudioMixer` | Core | `core/AudioMixer.ts` |
| `AudioMixerSource` | Core | `core/AudioMixer.ts:10` |
| `AudioMixerEventMap` | Core | `core/AudioMixer.ts:18` |
| `TrackEvent` (enum) | Events | `events/TrackEvents.ts:17` |
| `TrackEventMap` | Events | `events/TrackEvents.ts:79` |
| `TrackEventPayload` | Events | `events/TrackEvents.ts:94` |
| `ProcessorUpdatePayload` | Events | `events/TrackEvents.ts:45` |
| `FeatureUpdatePayload` | Events | `events/TrackEvents.ts:55` |
| `TrackErrorPayload` | Events | `events/TrackEvents.ts:65` |
| `ProcessorEvent` (enum) | Events | `events/ProcessorEvents.ts:14` |
| `ProcessorEventMap` | Events | `events/ProcessorEvents.ts:63` |
| `ProcessorEventPayload` | Events | `events/ProcessorEvents.ts:75` |
| `ProcessorErrorPayload` | Events | `events/ProcessorEvents.ts:36` |
| `ProcessorDataPayload` | Events | `events/ProcessorEvents.ts:47` |
| `VADDataPayload` | Events | `events/ProcessorEvents.ts:84` |
| `TranscriptionDataPayload` | Events | `events/ProcessorEvents.ts:96` |
| `SpeakerRecognitionDataPayload` | Events | `events/ProcessorEvents.ts:113` |
| `TypedEventEmitter` | Events | `events/EventEmitter.ts:46` |
| `EventMap` | Events | `events/EventEmitter.ts:14` |
| `EventHandler` | Events | `events/EventEmitter.ts:19` |
| `TrackProcessor` | Processors | `processors/types.ts:69` |
| `EventEmittingProcessor` | Processors | `processors/types.ts:144` |
| `ProcessorOptions` | Processors | `processors/types.ts:18` |
| `AudioProcessorOptions` | Processors | `processors/types.ts:30` |
| `ProcessorFactory` | Processors | `processors/types.ts:154` |
| `ProcessorConfig` | Processors | `processors/types.ts:161` |
| `ProcessorStatus` (enum) | Processors | `processors/types.ts:232` |
| `ProcessorInfo` | Processors | `processors/types.ts:252` |
| `BaseProcessor` | Processors | `processors/BaseProcessor.ts` |
| `NativeProcessor` | Processors | `processors/NativeProcessor.ts` |
| `createNativeProcessor` | Processors | `processors/NativeProcessor.ts:124` |
| `NativeProcessorOptions` | Processors | `processors/NativeProcessor.ts:16` |
| `RoomProvider` | Components | `components/RoomProvider.tsx` |
| `RoomProviderProps` | Components | `components/RoomProvider.tsx:59` |
| `RoomContextValue` | Components | `components/RoomProvider.tsx:19` |
| `AudioTrackRenderer` | Components | `components/AudioTrackRenderer.tsx` |
| `AudioTrackRendererProps` | Components | `components/AudioTrackRenderer.tsx` |
| `useRoom` | Hooks | `hooks/` |
| `useRoomSafe` | Hooks | `hooks/` |
| `useAudioTrack` | Hooks | `hooks/useAudioTrack.ts` |
| `UseAudioTrackOptions` | Hooks | `hooks/useAudioTrack.ts:16` |
| `UseAudioTrackReturn` | Hooks | `hooks/useAudioTrack.ts:30` |
| `useProcessors` | Hooks | `hooks/useProcessors.ts` |
| `UseProcessorsOptions` | Hooks | `hooks/useProcessors.ts:16` |
| `UseProcessorsReturn` | Hooks | `hooks/useProcessors.ts:28` |
| `useAudioLevel` | Hooks | `hooks/useAudioLevel.ts` |
| `useMediaStreamAudioLevel` | Hooks | `hooks/useAudioLevel.ts:133` |
| `UseAudioLevelOptions` | Hooks | `hooks/useAudioLevel.ts:15` |
| `UseAudioLevelReturn` | Hooks | `hooks/useAudioLevel.ts:28` |
| `useDevices` | Hooks | `hooks/useDevices.ts` |
| `UseDevicesOptions` | Hooks | `hooks/useDevices.ts:18` |
| `UseDevicesReturn` | Hooks | `hooks/useDevices.ts:28` |
| `DeviceKind` | Hooks | `hooks/useDevices.ts:13` |
| `useBrowserCapabilities` | Hooks | `hooks/useBrowserCapabilities.ts` |
| `UseBrowserCapabilitiesReturn` | Hooks | `hooks/useBrowserCapabilities.ts:11` |
| `useAudioMixer` | Hooks | `hooks/useAudioMixer.ts` |
| `UseAudioMixerReturn` | Hooks | `hooks/useAudioMixer.ts:11` |
| `debugLog` | Utils | `utils/debugLogger.ts` |
| `debugLogConfig` | Utils | `utils/debugLogger.ts` |
| `debugLogTranscript` | Utils | `utils/debugLogger.ts` |
| `DebugTranscriptEntry` | Utils | `utils/debugLogger.ts` |
| `DebugTranscriptWord` | Utils | `utils/debugLogger.ts` |
| `isBrowser` | Utils | `utils/browserSupport.ts:12` |
| `isSafari` | Utils | `utils/browserSupport.ts:19` |
| `getSafariVersion` | Utils | `utils/browserSupport.ts:29` |
| `isSafariVersionSupported` | Utils | `utils/browserSupport.ts:41` |
| `isGetUserMediaSupported` | Utils | `utils/browserSupport.ts:53` |
| `isAudioContextSupported` | Utils | `utils/browserSupport.ts:62` |
| `isAudioWorkletSupported` | Utils | `utils/browserSupport.ts:71` |
| `isMediaStreamTrackSupported` | Utils | `utils/browserSupport.ts:79` |
| `isSharedArrayBufferSupported` | Utils | `utils/browserSupport.ts:89` |
| `getBrowserSupport` | Utils | `utils/browserSupport.ts:102` |
| `isBasicAudioSupported` | Utils | `utils/browserSupport.ts:125` |
| `isWebAudioSupported` | Utils | `utils/browserSupport.ts:132` |
| `isAdvancedAudioSupported` | Utils | `utils/browserSupport.ts:139` |
| `getAudioContextConstructor` | Utils | `utils/browserSupport.ts:146` |
| `detectBrowserName` | Utils | `utils/browserCompatibility.ts:22` |
| `detectBrowserVersion` | Utils | `utils/browserCompatibility.ts:40` |
| `meetsMinimumVersion` | Utils | `utils/browserCompatibility.ts:62` |
| `detectWasmSimd` | Utils | `utils/browserCompatibility.ts:72` |
| `getBrowserCapabilities` | Utils | `utils/browserCompatibility.ts:86` |
| `getBrowserLimitations` | Utils | `utils/browserCompatibility.ts:116` |
| `buildAudioConstraints` | Utils | `utils/constraints.ts:15` |
| `getTrackFeatures` | Utils | `utils/constraints.ts:54` |
| `applyFeatureConstraint` | Utils | `utils/constraints.ts:79` |
| `isFeatureSupported` | Utils | `utils/constraints.ts:96` |
| `getSupportedFeatures` | Utils | `utils/constraints.ts:130` |
| `createWorkletLoader` | Utils | `utils/workletLoader.ts:42` |
| `WorkletLoader` | Utils | `utils/workletLoader.ts:15` |
| `WorkletLoaderOptions` | Utils | `utils/workletLoader.ts:8` |
| `calculateRMSLevel` | Utils | `utils/audioUtils.ts:14` |
| `calculatePeakLevel` | Utils | `utils/audioUtils.ts:33` |
| `linearToDecibels` | Utils | `utils/audioUtils.ts:53` |
| `decibelsToLinear` | Utils | `utils/audioUtils.ts:64` |
| `detectVoiceActivity` | Utils | `utils/audioUtils.ts:75` |
| `createSmoothingCalculator` | Utils | `utils/audioUtils.ts:85` |
| `createSilenceDetector` | Utils | `utils/audioUtils.ts:100` |
| `resampleAudio` | Utils | `utils/audioUtils.ts:137` |
| `audioBufferToFloat32` | Utils | `utils/audioUtils.ts:164` |
| `audioBufferToTrack` | Utils | `utils/audioUtils.ts:175` |
| `sleep` | Utils | `utils/audioUtils.ts:191` |

---

## 3. Strengths

1. **Clean plugin contract.** `TrackProcessor` (`processors/types.ts:69`) is minimal and well-typed. Separating `init/restart/destroy` from the optional `onAttach/onDetach/enable/disable` is a well-reasoned split that avoids forcing boilerplate on simple plugins.

2. **Typed event system.** `TypedEventEmitter<TEvents>` wraps `eventemitter3` with full TypeScript inference. The `on()` return value is an unsubscribe function, which is a React-friendly pattern.

3. **Reference-counted AudioContext.** `AudioContextManager` avoids the common error of creating a new context per component. The reference-count pattern is correct and tested.

4. **AsyncLock in AudioTrack.** The `processorLock` (`core/AudioTrack.ts:18-43`) serialises concurrent `setProcessor`/`stopProcessor` calls — a non-obvious but necessary guard against race conditions when the React component cycles rapidly.

5. **ProcessorPipeline track chaining.** Each processor receives the previous processor's `processedTrack` as its `track` input, forming a correct linear chain (`core/ProcessorPipeline.ts:176-196`).

6. **`workletLoader` shared utility.** Centralising blob-URL caching and `WeakSet`-based context registration in `createWorkletLoader` avoids duplicating this pattern in `@arcaai/vad` and `@arcaai/noise-filter`.

7. **Good test surface breadth.** Processor pipeline ordering, chaining, enable/disable, and audio level monitoring are all exercised in unit tests. The Playwright suite tests real `AudioContext` and `getUserMedia` in Chromium/Firefox/WebKit.

8. **`AudioMixer` 1/√N normalization.** Correct multi-source mix gain strategy to avoid clipping (`core/AudioMixer.ts:146`).

---

## 4. Defects & Bugs

### 4.1 Critical

---

**[CRITICAL-1] `AudioContextManager` singleton survives React StrictMode double-invocation, producing a leaked context**

File: `src/core/AudioContextManager.ts:30-86` / `src/components/RoomProvider.tsx:92-204`

In React 18/19 StrictMode, effects and `useState` initialisers fire twice in development. `RoomProvider` creates the `Room` inside `useState` (line 94), which calls `AudioContextManager.getInstance()`. The `Room` constructor then calls `contextManager = AudioContextManager.getInstance(options)` (line 113 of `Room.ts`). On the second StrictMode invocation, the singleton already exists, so a second `Room` is created pointing at the same instance. When the first `Room` is unmounted, it calls `contextManager.release()`, decrementing `referenceCount` to 0, which calls `closeContext()` — closing the `AudioContext` that the still-alive second `Room` depends on.

Additionally, `useEffect` in `RoomProvider` (lines 140-153) fires `room.connect()` on mount and `room.disconnect()` on cleanup, but in StrictMode the cleanup fires before re-mount, so `AudioContextManager.release()` is called while the same `Room` instance still holds a reference from the still-running connect.

**Concrete symptom**: In development mode with `autoConnect={true}`, the `AudioContext` is closed after the first effect-cleanup cycle, leaving the app permanently broken unless the user manually calls `resumeAudio()`.

**Fix**: Use an `isFirstRender` ref guard in the cleanup, or call `AudioContextManager.resetInstance()` / adopt an explicit `acquire`/`release` pattern that distinguishes the setup phase from the teardown phase.

---

**[CRITICAL-2] `createLocalTracks` utility leaks an `AudioContext` on every call**

File: `src/core/Room.ts:331-343`

```ts
// Room.ts:337
const ctx = new AudioContext({ latencyHint: 'interactive' });
track.setAudioContext(ctx);
await track.setProcessor(options.processor);
```

When `options.processor` is supplied, `createLocalTracks` creates a raw `new AudioContext(...)` that is never tracked by `AudioContextManager`, never closed, and never returned to the caller. The `AudioTrack` it creates also does not stop the context on `track.stop()`. Multiple calls (e.g., retrying capture after a permission denial) accumulate unreleased contexts.

**Fix**: Use `AudioContextManager.getInstance().acquire()` and release it in a `track.on(TrackEvent.Ended, …)` listener, or pass the context from the caller.

---

### 4.2 High

---

**[HIGH-1] `getUserMedia` error handling is incomplete — `OverconstrainedError` and `NotReadableError` are silently swallowed as `UNKNOWN`**

File: `src/core/AudioTrack.ts:554-573`

```ts
switch (error.name) {
  case 'NotAllowedError': …
  case 'NotFoundError': …
  case 'NotReadableError': …   ← mapped correctly
  default:
    return new RoomError(RoomErrorCode.UNKNOWN, error.message, error);
}
```

`OverconstrainedError` (a `DOMException` with `name === 'OverconstrainedError'`) is not handled. This is common when the caller passes a `deviceId: { exact: '...' }` for a device that no longer exists (e.g., a USB mic was unplugged between `enumerateDevices` and `getUserMedia`). The caller receives `RoomErrorCode.UNKNOWN` with no actionable guidance, and no `RoomErrorCode.DEVICE_NOT_FOUND` mapping.

Similarly `AbortError` and `SecurityError` fall through to `UNKNOWN`.

**Fix**: Add `case 'OverconstrainedError': return new RoomError(RoomErrorCode.DEVICE_NOT_FOUND, ...)` and `case 'SecurityError'` / `'AbortError'` branches.

---

**[HIGH-2] Track-ended event does not stop/clean up processor or audio nodes**

File: `src/core/AudioTrack.ts:546-549`

```ts
private handleTrackEnded(): void {
  this.state = TrackState.ENDED;
  this.emit(TrackEvent.Ended);
}
```

When a device is unplugged the OS fires `track.onended`. `handleTrackEnded` only updates `state` and emits the event — it does **not** stop the current processor, disconnect the `sourceNode`/`analyserNode`, clear the `levelMonitorInterval`, or nullify `sourceTrack`. The `MediaStreamAudioSourceNode` holds a live reference to the now-dead track, the `setInterval` continues firing (calling `analyserNode.getFloatTimeDomainData` on a detached source — undefined behaviour in some browsers), and `processedTrack` stays populated with a stale track.

Contrast with `stop()` (line 514-541) which does all the correct cleanup.

**Fix**: `handleTrackEnded` should call `this.stop()` (or an internal equivalent that does not re-emit `Ended` to avoid double-emit) so all resources are freed.

---

**[HIGH-3] `AudioContextManager.resumeWithTimeout` silently swallows the timeout branch**

File: `src/core/AudioContextManager.ts:249-259`

```ts
private async resumeWithTimeout(timeoutMs = 500): Promise<void> {
  if (!this.audioContext) return;
  try {
    await Promise.race([this.audioContext.resume(), this.sleep(timeoutMs)]);
  } catch (error) {
    console.warn('Could not resume AudioContext:', error);
    this.setupClickHandler(this.audioContext);
  }
}
```

`Promise.race` resolves with the winner's value. If `sleep` wins (i.e., the `resume()` takes more than 500 ms, which is common on iOS), the race resolves `undefined` — but `this.audioContext.state` is still `'suspended'`. The function returns silently without setting up the click handler, because `sleep` did not throw. The click handler is only set up in the `catch` branch.

`room.connect()` then calls `this.emit(RoomEvent.Connected)` even though the `AudioContext` is still suspended, so callers believe the room is ready when it is not.

**Fix**: After `Promise.race`, check `if (this.audioContext.state !== 'running') { this.setupClickHandler(this.audioContext); }`.

---

**[HIGH-4] `useAudioTrack` event listeners are registered after `initialize()`, creating a race**

File: `src/hooks/useAudioTrack.ts:140-156`

```ts
const newTrack = new AudioTrack(trackOptions);

const handleMuted = () => setIsMuted(true);
const handleEnded = () => { setIsCapturing(false); setState(newTrack.getState()); };

newTrack.on(TrackEvent.Muted, handleMuted);
newTrack.on(TrackEvent.Unmuted, handleUnmuted);
newTrack.on(TrackEvent.Ended, handleEnded);

await newTrack.initialize(mergedOptions);   // ← getUserMedia happens here
```

The listeners are registered before `initialize()`, which is correct. However, `initialize()` itself calls `setupAudioLevelMonitoring()` (which starts a `setInterval`) and then, if a processor was already set, calls `setProcessor()`. If `getUserMedia` succeeds but the component unmounts before `initialize()` resolves, the cleanup `useEffect` fires:

```ts
// useAudioTrack.ts:224-231
return () => {
  if (trackRef.current) {
    trackRef.current.stop().catch(() => {});
  }
};
```

But `trackRef.current` is null at this point because `trackRef.current = newTrack` is set only **after** `initialize()` resolves (line 153). So `trackRef.current?.stop()` is a no-op, and the `MediaStreamTrack`, `setInterval`, and `AudioContext` nodes are all leaked.

**Fix**: Set `trackRef.current = newTrack` immediately after constructing it, before `initialize()`, and also set a flag to abort if the component unmounts mid-flight.

---

**[HIGH-5] `useDevices.enumerateDevices` captures stale closures over `selectedInputDeviceId`/`selectedOutputDeviceId`**

File: `src/hooks/useDevices.ts:118-158`

```ts
const enumerateDevices = useCallback(async () => {
  ...
  if (!selectedInputDeviceId) { ... }
  if (!selectedOutputDeviceId) { ... }
}, [selectedInputDeviceId, selectedOutputDeviceId]);   // ← line 158
```

`enumerateDevices` is used as the `devicechange` event handler (line 196-203). Because the handler is re-registered whenever either `selectedXxxDeviceId` changes, React will continuously un-register and re-register the `devicechange` listener on every device selection — but worse, the `eslint-disable` comment on line 187 suppresses the exhaustive-deps warning for the initial `useEffect`, meaning the `init` function captures a stale closure that never re-runs on `autoRequestPermissions` changes.

**Fix**: The `devicechange` handler should call a stable function that does not capture the device IDs.

---

### 4.3 Medium

---

**[MEDIUM-1] No sample-rate mismatch detection between `AudioContext` and downstream consumers**

There is no runtime check or warning when `AudioContext.sampleRate` ≠ 48 000 Hz (e.g., on macOS with a 44 100 Hz aggregate device). `resampleAudio` (`audioUtils.ts:137`) is exported but never called inside the pipeline — it must be invoked by each plugin independently. If a plugin such as `@arcaai/noise-filter` creates a `MediaStreamAudioDestinationNode` on a 44 100 Hz context and passes the raw track to RNNoise (which expects 48 kHz frames), the WASM will process garbled audio silently.

**Fix**: Add `AudioContextManager.ensureSampleRate(expected: number)` that logs a warning (or throws) when the context rate differs from what the plugins expect.

---

**[MEDIUM-2] `ProcessorPipeline.rebuildPipeline` destroys and re-inits all processors on every `setEnabled` call**

File: `src/core/ProcessorPipeline.ts:201-209`

```ts
private async rebuildPipeline(): Promise<void> {
  await this.destroyAllProcessors();
  await this.buildPipeline(this.currentOptions);
}
```

`destroyAllProcessors` iterates over **all** `this.processors`, not just the ones that need rebuilding. Every time a single processor is enabled or disabled, every other processor in the pipeline is torn down and re-initialized. For WASM-backed plugins (`@arcaai/vad`, `@arcaai/noise-filter`) this means re-loading and re-instantiating the WASM module on every toggle — which can take 100–500 ms and produces an audible gap.

**Fix**: Instead of a full rebuild, implement a bypass mechanism where disabled processors short-circuit their audio graph (e.g., reconnecting source directly to destination) without destroying WASM state.

---

**[MEDIUM-3] `AudioTrack.setupAudioLevelMonitoring` always creates a new `MediaStreamAudioSourceNode` even when one already exists**

File: `src/core/AudioTrack.ts:429-450`

When `restart()` is called, `stop()` disconnects `sourceNode` and sets it to `null`, then `initialize()` calls `setupAudioLevelMonitoring()` again. This is correct. However, if `setAudioContext(ctx)` is called on an already-active track (e.g., after a device switch), no new monitoring graph is set up because `setupAudioLevelMonitoring()` is not called again — the old `sourceNode` is still connected to the old `analyserNode` which may be in a different graph.

More concretely: if a user switches the `AudioContext` via `setAudioContext()` while audio is live, the level monitoring stays on the old context.

---

**[MEDIUM-4] `useMediaStreamAudioLevel` creates a new `AudioContext` per `MediaStreamTrack` with no coordination with `AudioContextManager`**

File: `src/hooks/useAudioLevel.ts:153`

```ts
audioContextRef.current = new AudioContext({ latencyHint: 'interactive' });
```

This bypasses the singleton entirely, so every `useMediaStreamAudioLevel` call that runs in the same page instantiates its own `AudioContext`. Browsers enforce a limit on simultaneous `AudioContext` instances (Chrome deprecated >6 concurrent). In a scenario with a device picker showing a live level meter per device, this quickly exhausts the budget.

**Fix**: Use `AudioContextManager.getInstance().getContext()` if available, or share a single `AudioContext` for monitoring.

---

**[MEDIUM-5] `getNewAudioContext` in `AudioContextManager.ts` duplicates the suspended-state click-handler setup but only listens on `click`/`touchstart`, missing `keydown`**

File: `src/core/AudioContextManager.ts:344-358`

The standalone `getNewAudioContext` function registers handlers on `click` and `touchstart` but not `keydown`. The singleton's `setupClickHandler` does add `keydown` (line 281). This inconsistency means audio started via keyboard (e.g., pressing Space to record) will not resume if the context was suspended and the standalone function was used.

---

**[MEDIUM-6] `AudioMixer.removeSource` unconditionally stops all MediaStream tracks**

File: `src/core/AudioMixer.ts:74-85`

```ts
source.stream.getTracks().forEach((t) => t.stop());
```

The mixer does not own the `MediaStream` lifecycle — it was passed in from outside. Stopping the tracks when removing a source destroys the caller's stream, which may still be active (e.g., for a UI preview or a second processor). This is a "surprising API" defect. The same issue exists in `dispose()` via `removeSource`.

**Fix**: Remove the `t.stop()` call. Document that the caller is responsible for stopping their own tracks.

---

**[MEDIUM-7] `useProcessors` can attach the same pipeline instance to the track multiple times**

File: `src/hooks/useProcessors.ts:127-142`

```ts
if (!pipeline) {
  pipeline = new ProcessorPipeline();
  setProcessor(pipeline);
}
pipeline.add(newProcessor, processorOptions);
if (track.getProcessor() !== pipeline) {
  await track.setProcessor(pipeline);
}
```

The `pipeline` local variable comes from `processor as ProcessorPipeline | null`, which is stale React state. If `addProcessor` is called twice in rapid succession before the first render cycle completes, both calls find `pipeline === null`, create two separate `ProcessorPipeline` instances, and both call `track.setProcessor()`. The second call destroys the first pipeline (and its processors) via `stopProcessorInternal`, leaving `processor` state pointing at the second pipeline while the first pipeline's processors are destroyed. The React state update from the first call (`setProcessor(pipeline)`) is also discarded by the second call's `setProcessor(pipeline)`.

---

**[MEDIUM-8] `isBrowser()` guard is missing from `AudioContextManager.createAudioContext()`**

File: `src/core/AudioContextManager.ts:191-214`

`createAudioContext` calls `getAudioContextConstructor()` which calls `isBrowser()` and returns `undefined` in SSR/Node. But `createAudioContext` calls `new AudioContextCtor(options)` only after a null check:

```ts
if (!AudioContextCtor) {
  throw new RoomError(RoomErrorCode.NOT_SUPPORTED, …);
}
```

This is correct. However `acquire()` (line 95) does **not** guard against being called in a non-browser environment before `this.options.audioContext` is set. In an SSR framework (e.g., Next.js App Router with `"use client"` missing), `acquire()` is called synchronously during module evaluation, hits `createAudioContext()`, which throws `NOT_SUPPORTED` rather than a graceful no-op.

`isBrowser()` also only checks `window` and `navigator`, which is not sufficient in Deno or some SSR runtimes. A tighter check would be `typeof AudioContext !== 'undefined'`.

---

**[MEDIUM-9] `recommendedSampleRate` is hardcoded to 48 000 for all browsers, including Safari**

File: `src/utils/browserCompatibility.ts:109`

```ts
recommendedSampleRate: isSafariAny ? 48000 : 48000,
```

The ternary always evaluates to 48 000. The comment "Safari" branch appears to intend a different value (44 100 is the native hardware rate on most Apple Silicon Macs). This is dead code and misleads future developers. Any consumer that reads `recommendedSampleRate` to decide the `AudioContext.sampleRate` will always get 48 000, even on hardware that natively runs at 44 100.

---

### 4.4 Low

---

**[LOW-1] `AudioTrack.isMuted()` has two sources of truth that can disagree**

File: `src/core/AudioTrack.ts:224-226`

```ts
isMuted(): boolean {
  return this.state === TrackState.MUTED || this.sourceTrack?.enabled === false;
}
```

If something externally calls `sourceTrack.enabled = false` (e.g., via another API layer), `isMuted()` returns `true` but `state` is still `TrackState.ACTIVE`. The `TrackEvent.Muted` is never emitted, so `useAudioTrack.isMuted` state stays `false`. The hook and the actual track disagree.

---

**[LOW-2] `AudioTrack.updateAudioLevel` allocates a `Float32Array` on every interval tick**

File: `src/core/AudioTrack.ts:455-479`

```ts
private updateAudioLevel(): void {
  const bufferLength = this.analyserNode.fftSize;
  const dataArray = new Float32Array(bufferLength);   // ← 2048 * 4 = 8 KB per tick
  this.analyserNode.getFloatTimeDomainData(dataArray);
  ...
}
```

At the default 50 ms interval, this allocates a fresh 8 KB `Float32Array` twenty times per second. Contrast with `useMediaStreamAudioLevel` which correctly allocates `dataArray` once outside the `setInterval` callback (`useAudioLevel.ts:163`). This pattern will trigger GC pressure in long sessions.

**Fix**: Allocate `this._dataArray` once in `setupAudioLevelMonitoring` and reuse it.

---

**[LOW-3] `TypedEventEmitter.once()` does not return an unsubscribe function**

File: `src/events/EventEmitter.ts:72-75`

```ts
once<K>(event: K, handler: EventHandler<TEvents[K]>): void {
```

The `on()` method returns `() => void` (an unsubscriber), making it ergonomic for React `useEffect` cleanups. `once()` returns `void`, forcing callers to store the handler separately and call `off()` manually if they need to cancel before the event fires.

---

**[LOW-4] `applyFeatureConstraint` spreads all track settings into new constraints, potentially re-applying unsupported settings**

File: `src/utils/constraints.ts:80-88`

```ts
const constraints: MediaTrackConstraints = {
  ...currentSettings,   // spreads width, height, frameRate, etc.
  [feature]: enabled,
};
await track.applyConstraints(constraints);
```

`getSettings()` returns all current settings including `width`, `height`, `frameRate`, etc. from a media stream that may have been constrained differently. Spreading them back into `applyConstraints` can fail with `OverconstrainedError` if any of the re-applied settings are now unsupported (e.g., after a device switch). The intent is just to flip one boolean feature flag.

**Fix**: `await track.applyConstraints({ [feature]: enabled })` — the browser merges with existing constraints without needing to re-specify them.

---

**[LOW-5] `AudioTrack.restart()` does not await `this.stop()` errors before calling `initialize()`**

File: `src/core/AudioTrack.ts:497-509`

If `stop()` throws (e.g., processor `onDestroy` rejects), `restart()` propagates the error and never reaches `initialize()`, leaving the track in `TrackState.ENDED` with a destroyed processor and nulled `sourceTrack` — but the track object is still in `Room.localTracks`. The Room has no cleanup handler for this case.

---

**[LOW-6] `AudioTrack.unmute()` does not guard against calling on a stopped track**

File: `src/core/AudioTrack.ts:240-247`

```ts
unmute(): void {
  if (this.sourceTrack) {
    this.sourceTrack.enabled = true;
    this.state = TrackState.ACTIVE;
    this.emit(TrackEvent.Unmuted);
  }
}
```

If `stop()` has already been called, `this.sourceTrack` is `null` (line 535-537), so `unmute()` silently does nothing — which is correct behavior. However, `this.state` is already `TrackState.ENDED`, and there is no guard preventing the state from being incorrectly reset. Actually the guard via `if (this.sourceTrack)` prevents the state change, but this is implicit. A defensive check `if (this.state === TrackState.ENDED) return;` would be clearer and prevent future regressions.

---

## 5. Security

### 5.1 Device Permission Handling

- `useDevices.requestPermissionsAsync()` (`useDevices.ts:161-173`) calls `getUserMedia({ audio: true })` and immediately stops all returned tracks. This is the standard permission-probe pattern and is acceptable.
- Permissions are inferred by checking whether device labels are non-empty (`hasLabels` check, line 136). This heuristic is reliable but can produce a false positive if the device label happens to contain the truncated `deviceId` substring.
- There is no integration with the **Permissions API** (`navigator.permissions.query({ name: 'microphone' })`). This means `hasPermissions` is always `false` on first render (since `enumerateDevices` returns empty labels before permission), requiring an extra render cycle.

### 5.2 Device Leakage

- **Bluetooth/HID device leakage**: The `useDevices` hook does not filter by device kind before presenting — it shows all `audioinput` and `audiooutput` devices including Bluetooth HID (headsets, hearing aids, medical peripherals). `enumerateDevices()` includes these when permission is granted. The `AudioDevice.label` field is presented raw to the UI, which in a healthcare context could reveal the presence of sensitive medical audio devices (e.g., "Phonak hearing aid (Bluetooth)").
- **Recommendation**: In a healthcare context, apply a `groupId` or label-pattern denylist for known hearing-aid/medical-device vendors.

### 5.3 Other

- `RoomError` exposes the full `DOMException` as `.cause`, which some logging systems will serialise and ship to remote log aggregators. Ensure `.cause` is stripped or sanitized before logging.
- There is no `Permissions-Policy` enforcement at the API layer — the package does not check or document that the consuming page must set `Permissions-Policy: microphone=self`.

---

## 6. Performance

### 6.1 Unnecessary Re-Renders

- `RoomProvider.contextValue` is memoized via `useMemo` with correct dependencies (`room, state, localTracks, connect, …`). `room` is stable (created in `useState`). `connect`/`disconnect`/etc. are `useCallback` with `[room]` dependencies. This is correct — no spurious re-renders here.
- `useAudioLevel` calls `setAudioLevelInfo(info)` on every `AudioLevelUpdate` event (up to 20 Hz). Each call schedules a React render. Components subscribed to `useAudioLevel` re-render 20 times per second even when the level doesn't change. A `shouldUpdate` check (`Math.abs(prev.level - info.level) > 0.005`) would prune most updates.

### 6.2 Buffer Copies

- `AudioTrack.updateAudioLevel()` allocates a new `Float32Array(2048)` every 50 ms (see LOW-2 above).
- `ProcessorPipeline.buildPipeline()` chains tracks via `MediaStreamAudioDestinationNode` → `MediaStreamAudioSourceNode` at each processor boundary. Each node transition involves a copy from/to native audio buffers. For a 3-plugin pipeline (noise → VAD → STT), there are 3 such copies at 48 kHz × stereo × 32-bit float = ~12 MB/s of buffer traffic. This is unavoidable with the current `MediaStreamTrack`-chaining model, but an `AudioWorklet`-to-`AudioWorklet` direct buffer transfer via `SharedArrayBuffer` would eliminate it.

### 6.3 Latency Budget

- Default `latencyHint: 'interactive'` is correct for real-time capture. No issue.
- The `AudioTrack` level monitoring interval defaults to 50 ms (`audioLevelInterval?: number` default at line 443). At 48 kHz with `fftSize = 2048`, 50 ms is 2400 samples — well within one `fftSize` window. This is fine.
- `ProcessorPipeline` rebuilds synchronously on every `setEnabled`/`remove` call. For WASM plugins, rebuild latency is 100–500 ms (see MEDIUM-2). During this window, `processedTrack` is the previous output — STT/VAD consumers continue to read from it until the rebuild completes, potentially causing a brief stale-track feed.

---

## 7. Test Coverage Gaps

| Scenario | Covered? | Notes |
|---|---|---|
| StrictMode double-mount AudioContextManager leak | **No** | Critical-1 uncovered |
| `createLocalTracks` AudioContext leak | **No** | Critical-2 uncovered |
| `resumeWithTimeout` race (sleep wins) | **No** | High-3 uncovered |
| `OverconstrainedError` from `getUserMedia` | **No** | High-1 partial |
| `AbortError`, `SecurityError` from `getUserMedia` | **No** | High-1 uncovered |
| Track `onended` when device unplugged | **No** | High-2 uncovered |
| `useAudioTrack` unmount-before-initialize leak | **No** | High-4 uncovered |
| `ProcessorPipeline.rebuildPipeline` WASM re-init cost | Partial (tested rebuild happens; not tested that it is destructive to WASM) | |
| `AudioMixer.removeSource` stops caller's tracks | **No** | Medium-6 uncovered |
| SSR environment (Node.js) `acquire()` call | **No** | Medium-8 uncovered |
| `useMediaStreamAudioLevel` AudioContext count per call | **No** | Medium-4 uncovered |
| Sample-rate mismatch warning | **No** | Medium-1 uncovered |
| Multiple concurrent `addProcessor` calls | **No** | Medium-7 uncovered |
| `isMuted()` disagreement with external `enabled=false` | **No** | Low-1 uncovered |
| Float32Array allocation in `updateAudioLevel` | **No** | Low-2 uncovered |
| `once()` returns no unsubscriber | **No** | Low-3 uncovered |
| Rapid connect/disconnect cycle | Partial (Room.test.ts line 209 tests idempotency but not rapid cycling) | |
| Permissions API integration | **No** | Not implemented; no test |
| Bluetooth/medical device in `useDevices` | **No** | |

---

## 8. Conformance to Best Practices

### 8.1 AudioWorklet

The package provides `createWorkletLoader` as a shared utility (`utils/workletLoader.ts`), but **no AudioWorklet is implemented inside `@arcaai/room` itself**. All audio graph operations use `AnalyserNode`, `GainNode`, `MediaStreamAudioSourceNode`, and `MediaStreamAudioDestinationNode` — the Web Audio API node graph, not worklets.

The plugins (`@arcaai/vad`, `@arcaai/noise-filter`) are expected to use worklets internally. The `WorkletLoader` utility properly uses a `WeakSet<AudioContext>` to avoid double-registration and blob-URL caching — this is correct.

**Missing best practices:**
- No transferable usage (`Transferable` objects) in the context of audio data. The inter-processor track handoff goes through `MediaStreamTrack`, not `SharedArrayBuffer`. This means data crosses the main thread multiple times.
- No `AudioWorkletNode.port.postMessage` with `{ transfer: [buffer.buffer] }` pattern is documented in the plugin guide.
- The README plugin guide recommends `setInterval` for VAD (README:366), which is main-thread polling — inferior to AudioWorklet-based processing.

### 8.2 WebRTC Adapter

No `webrtc-adapter` polyfill is used or documented. The package implements its own UA-sniffing for Safari version detection (`browserCompatibility.ts:22-35`, `browserSupport.ts:19-35`). The UA sniffing for Safari is the canonical `/^((?!chrome|android).)*safari/i.test(ua)` pattern, which is fragile to Chrome-on-iOS (since CriOS is excluded, this correctly identifies iOS Safari — this is correct).

**However**: Chrome 91 detection via `MIN_VERSIONS.chrome = 91` covers `getDisplayMedia` and most WebRTC features but does not cover `AudioWorklet`, which became stable in Chrome 66. The minimum version check is more conservative than needed for audio-only use cases.

### 8.3 MediaCapabilities API

The `MediaCapabilities` API (`navigator.mediaCapabilities.decodingInfo()`) is not used. It is relevant for determining hardware-decoded audio codec support (e.g., Opus) but not directly applicable to PCM microphone capture. This is acceptable for the current scope.

### 8.4 Autoplay / Permission Policies

- The `AudioContext` resume-on-user-interaction pattern (click/touchstart/keydown handlers) is correctly implemented.
- The `Permissions-Policy: microphone` check is not performed. If a parent frame sets `Permissions-Policy: microphone=()` (denying microphone access), `getUserMedia` will throw `NotAllowedError` — this is mapped to `RoomErrorCode.PERMISSION_DENIED` (correctly). The consumer has no way to distinguish "user denied" from "policy denied" without inspecting the underlying `DOMException`.

### 8.5 SharedArrayBuffer / COOP / COEP

`isSharedArrayBufferSupported()` checks for `typeof SharedArrayBuffer !== 'undefined'` (`browserSupport.ts:92-96`), which is correct. The limitation info (`getBrowserLimitations`) tells developers to add COOP/COEP headers — this is good documentation. No attempt to use `SharedArrayBuffer` internally (the package does not implement WASM processing itself), so this is purely advisory.

---

## 9. Concrete Refactor / Improvement Suggestions

**P0 (must fix before production):**

1. **Fix StrictMode double-mount (Critical-1).** In `RoomProvider`, replace `const [room] = useState(() => new Room(options))` with a `useRef` that is only created when `ref.current === null`. Separately, in `AudioContextManager`, add a `disposed` flag that prevents re-closing an already-closed context, and handle the case where `release()` is called on a context that has already been claimed by a new acquire cycle.

2. **Fix `createLocalTracks` context leak (Critical-2).** Either remove the `AudioContext` creation entirely (require callers to pass one) or route through `AudioContextManager` and close it in a `track.on(TrackEvent.Ended)` listener.

3. **Fix `resumeWithTimeout` silent race (High-3).** After `Promise.race`, check `if (this.audioContext.state !== 'running')` and call `this.setupClickHandler` unconditionally.

4. **Set `trackRef.current` before `initialize()` (High-4).** This prevents the unmount-during-capture leak in `useAudioTrack`.

**P1 (fix before stable release):**

5. **Add `OverconstrainedError`, `AbortError`, `SecurityError` handling (High-1).** Map to appropriate `RoomErrorCode` values.

6. **Fix `handleTrackEnded` to call cleanup (High-2).** The simplest fix is `await this.stop()` inside the handler, guarded against double-calling `Ended`.

7. **Fix `AudioMixer.removeSource` — do not stop caller tracks (Medium-6).** Let callers control their own `MediaStream` lifecycle.

8. **Preallocate `Float32Array` in `updateAudioLevel` (Low-2).** Allocate once in `setupAudioLevelMonitoring`, store as `this._levelDataArray`.

9. **Add sample-rate mismatch warning (Medium-1).** Log `console.warn` when `audioContext.sampleRate !== 48000` and a plugin chain is initialized. For Whisper/Silero, explicitly document that `resampleAudio` must be called inside the plugin.

10. **Fix `ProcessorPipeline.rebuildPipeline` for enable/disable (Medium-2).** Implement a soft-bypass (route audio around the processor graph) instead of destroying and re-instantiating WASM state.

**P2 (quality improvements):**

11. **Return an unsubscriber from `TypedEventEmitter.once()` (Low-3).** One-line fix: `return () => this.off(event, handler)`.

12. **Integrate Permissions API (Medium).** On browsers that support it, check `navigator.permissions.query({ name: 'microphone' })` on mount in `useDevices` to pre-populate `hasPermissions` without a device enumeration round-trip.

13. **Add SSR guard in `AudioContextManager.acquire()` (Medium-8).** Return early or throw with a clear error message when not in a browser environment.

14. **Replace `setInterval`-based audio monitoring with `requestAnimationFrame` (Performance).** For the level monitor, RAF is more appropriate than `setInterval`: it pauses when the tab is hidden, runs at display rate, and avoids timer drift. Alternatively, use a worklet `MessagePort` for sub-frame precision.

15. **Document transferable usage in plugin guide.** Update README plugin guide to show `AudioWorklet` usage with `SharedArrayBuffer` ringbuffer pattern instead of the `setInterval` polling example.

16. **Consider `audioContext.state === 'interrupted'` (iOS-specific).** On iOS 17+, the `AudioContext` state can transition to `'interrupted'` when a phone call interrupts. Handle this state in `AudioContextManager.ensureResumed()` by treating it the same as `'suspended'`.