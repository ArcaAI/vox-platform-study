# `@arcaai/vad` — Exhaustive Code Review

**Date:** 2026-05-23
**Reviewer:** AI Code Audit
**Scope:** All files under `packages/vad/` — source, tests, examples, assets, build config

---

## 1. Architecture

### 1.1 Model Loading Strategy

The package does **not** bundle the Silero ONNX model. Model loading is entirely delegated to `@ricky0123/vad-web`'s `MicVAD`. Two paths exist:

1. **CDN (default):** Assets and ONNX Runtime WASM are pulled from jsDelivr at runtime.

```32:33:packages/vad/src/processors/VADProcessor.ts
const DEFAULT_BASE_ASSET_PATH = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/';
const DEFAULT_ONNX_WASM_BASE_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
```

2. **Self-hosted:** User supplies `baseAssetPath` and `onnxWASMBasePath` options. No bundled copy ships with the package; `assets/README.md` lists the required files but they are not present in the repository.

### 1.2 ONNX Runtime Backend

The package does not configure `onnxruntime-web` directly — it is entirely hidden behind `@ricky0123/vad-web`. No `ort.env` is set. The runtime selects the backend automatically (typically `wasm` single-threaded unless `SharedArrayBuffer` + `crossOriginIsolated` are available for the multi-threaded proxy). There is **no WebGPU backend path** configured or documented.

### 1.3 Worklet / Worker Design

Two code paths exist for the AudioWorklet processor, which creates significant complexity:

**A — TypeScript source worklet (`src/worklets/vad.worklet.ts`)**
Compiled to `dist/worklets/vad.worklet.js` by tsup. Exported at `@arcaai/vad/worklet`. Contains `updateVADState()`, a method that is **never called from outside**.

**B — Inline blob-URL worklet (`src/worklets/worklet-loader.ts`)**
`generateWorkletSource()` returns a JavaScript string that duplicates the processor logic. This string is converted to a Blob URL and loaded via `audioWorklet.addModule()`. This is the path **actually used at runtime** — the TypeScript worklet file is dead code in practice.

```19:151:packages/vad/src/worklets/worklet-loader.ts
function generateWorkletSource(): string {
  return `
  // ... ~130 lines of duplicate plain-JS worklet code ...
  registerProcessor('vad-worklet-processor', VADWorkletProcessor);
  `;
}
```

The worklet's role is **audio passthrough + frame accumulation only**. All actual Silero inference runs inside `@ricky0123/vad-web` (on the main thread via its own internal worklet). Frames sent to the main thread via `postMessage` with transferable buffers are read by `vad-web`'s own machinery, not by `VADProcessor` — the `frame` message type from the custom worklet is **never consumed by `VADProcessor`**.

### 1.4 Integration Contract with `@arcaai/room`

`VADProcessor` extends `BaseProcessor` from `@arcaai/room` and overrides four lifecycle hooks: `onInit`, `onDestroy`, `onEnable`, `onDisable`.

```159:207:packages/vad/src/processors/VADProcessor.ts
protected async onInit(opts: AudioProcessorOptions): Promise<void> {
  const { audioContext, track } = opts;
  ...
  const stream = new MediaStream([track]);
  this.sourceNode = audioContext.createMediaStreamSource(stream);
  this.destinationNode = audioContext.createMediaStreamDestination();
  this.sourceNode.connect(this.destinationNode);
  this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  await this.initMicVAD(stream);
  ...
}
```

The integration is a **pure passthrough**: audio is routed source → destination unmodified. Speech detection probabilities come back via `MicVAD` callbacks, which trigger events via `BaseProcessor.emitData()`.

---

## 2. Public API

| Export | Type | Description |
|---|---|---|
| `VADProcessor` | class | Main processor; extends `BaseProcessor` |
| `createVAD(options?)` | factory | Shorthand for `new VADProcessor()` |
| `useVAD(options)` | React hook | Hook over `VADProcessor` |
| `DEFAULT_VAD_OPTIONS` | const | Merged defaults |
| `VADError` / `VADErrorCode` | class/enum | Typed errors |
| `VADModel`, `VADOptions`, `VADStats`, `VADFramePayload`, `VADSpeechStartPayload`, `VADSpeechRealStartPayload`, `VADSpeechEndPayload`, `VADMisfirePayload`, `VADStatsPayload`, `VADDataEventType` | types | All event and config shapes |
| `VADWorkletInboundMessage`, `VADWorkletOutboundMessage`, `VADWorkletConfig` | types | Worklet message types |
| `VADBrowserSupport` | type | Support detection result |
| `isVADSupported()`, `getVADBrowserSupport()`, `getRecommendedModel()`, `getFrameSamplesForModel()`, `isMultiThreadedONNXSupported()`, `logVADBrowserSupport()` | functions | Browser capability checks |
| `VAD_SAMPLE_RATE`, `FRAME_SIZE_V5`, `FRAME_SIZE_LEGACY` | consts | Numeric constants |
| `linearResample()`, `Resampler`, `downsampleTo16kHz()`, `upsampleFrom16kHz()` | utilities | Resampling helpers |
| `FrameAccumulator`, `AudioRingBuffer` | classes | Frame/buffer utilities |
| `durationToSamples()`, `samplesToDuration()`, `durationToFrames()`, `framesToDuration()` | functions | Conversion helpers |
| `WORKLET_PROCESSOR_NAME`, `isVADWorkletRegistered()` | worklet | Worklet identity |
| `registerVADWorklet()`, `createVADWorkletNode()`, `cleanupVADWorkletResources()` | worklet | Worklet lifecycle |

**VADProcessor instance methods:** `isSupported()`, `isSpeaking()`, `getSpeechProbability()`, `getStats()`, `getModel()`, `getOptions()`, `updateOptions()`, `updateThresholds()`, `pause()`, `start()`, `resetStats()`, `enable()`, `disable()`, `destroy()`

---

## 3. Strengths

1. **Clear architectural layering.** `VADProcessor` is a clean adapter: it adapts `@ricky0123/vad-web` into the `@arcaai/room` processor protocol without leaking internals.

2. **Correct Silero v5 frame size constant.** `FRAME_SIZE_V5 = 512` is accurate for Silero VAD v5 at 16 kHz.

3. **Accurate sample-rate documentation.** The `sampleRate` option is documented as "output audio in speech end events; model always processes at 16 kHz internally."

4. **Dual passthrough architecture protects audio pipeline.** The `sourceNode → destinationNode` passthrough means VAD never destructively modifies the audio, which is correct for a side-channel detector in a medical recording pipeline.

5. **Stream-relative timing metadata.** `VADSpeechEndPayload` includes `streamStartSec`, `streamEndSec`, `durationSec` — useful for downstream alignment with transcription.

6. **Good browser support detection.** The `browserSupport.ts` detects WASM, AudioWorklet, SharedArrayBuffer, cross-origin isolation, Safari AudioWorklet version (17.4+), and iOS separately.

7. **Deduplication via worklet registration cache.** `isVADWorkletRegistered()` prevents double-registration for the same `AudioContext`.

8. **Comprehensive utility coverage.** `FrameAccumulator`, `AudioRingBuffer`, `Resampler`, duration conversion helpers — all useful for consumers building custom pipelines.

9. **Vitest + Playwright dual test strategy.** Unit tests cover utilities and type shapes; E2E tests cover real browser behavior.

10. **tsup tree-shaking friendly.** `@ricky0123/vad-web` and `onnxruntime-web` are externalized, preventing bundle duplication.

---

## 4. Defects

### CRITICAL

---

**C-1 — CDN version pinned to stale `@ricky0123/vad-web@0.0.29` but package.json requires `^0.0.30`**

`packages/vad/src/processors/VADProcessor.ts:32`

```32:33:packages/vad/src/processors/VADProcessor.ts
const DEFAULT_BASE_ASSET_PATH = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/';
const DEFAULT_ONNX_WASM_BASE_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
```

`package.json:67` declares `"@ricky0123/vad-web": "^0.0.30"`. The default CDN path pins to `0.0.29`. When `npm install` resolves `^0.0.30`, it may pull code compiled against assets that differ from what the CDN URL serves. If the ONNX model file, worklet bundle, or WASM files at `0.0.29` diverge from `0.0.30`, inference will silently fail or produce wrong results. There is no integrity check. **This is a runtime correctness bug.**

---

**C-2 — `onnxruntime-web` CDN path pins to `1.22.0` but `devDependencies` declares `1.24.3`**

`packages/vad/src/processors/VADProcessor.ts:33`

```33:33:packages/vad/src/processors/VADProcessor.ts
const DEFAULT_ONNX_WASM_BASE_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';
```

`package.json:79` has `"onnxruntime-web": "^1.24.3"`. Serving WASM binaries at 1.22.0 against a runtime that expects 1.24.3 ABI breaks ONNX inference completely. ORT WASM files are not ABI-compatible across minor versions. **Sessions will fail to load.**

---

**C-3 — Custom worklet is entirely dead code; the actual inference worklet is invisible to consumers**

`src/worklets/vad.worklet.ts` and `worklet-loader.ts` define a `vad-worklet-processor` that accumulates frames and sends them to the main thread. However, `VADProcessor` never calls `registerVADWorklet()` or `createVADWorkletNode()` — it passes the stream directly to `MicVAD.new()` which internally registers **its own** worklet (`vad.worklet.bundle.min.js`) from the CDN. The custom worklet accumulator frames are posted to the main thread but there is **no `onmessage` handler in `VADProcessor` or anywhere else that consumes them**.

This means:
- `WORKLET_PROCESSOR_NAME`, `registerVADWorklet()`, `createVADWorkletNode()`, `cleanupVADWorkletResources()` are all public API for a worklet that is **never attached** in any real flow.
- The exported `@arcaai/vad/worklet` entry point is a dead build artifact.
- Consumers calling `registerVADWorklet(ctx)` then `createVADWorkletNode(ctx)` would create a node that is disconnected from everything.
- The `VADWorkletInboundMessage`, `VADWorkletOutboundMessage`, `VADWorkletConfig` types describe a protocol with no living implementation.

---

**C-4 — `updateVADState()` method in worklet is unreachable dead code**

`src/worklets/vad.worklet.ts:157–176`

```157:176:packages/vad/src/worklets/vad.worklet.ts
updateVADState(isSpeech: boolean, probability: number): void {
  const wasSpeaking = this.isSpeaking;
  this.isSpeaking = isSpeech;
  this.lastProbability = probability;
  ...
}
```

AudioWorklet processors cannot have methods called from the main thread — `AudioWorkletProcessor` subclasses run in a dedicated audio-processing thread with no direct object reference from the main thread. This method can only be reached from within the worklet's own code. Neither the inline blob worklet in `worklet-loader.ts` nor anything in `VADProcessor` ever calls it. It is unreachable at runtime.

---

### HIGH

---

**H-1 — Silero model hidden-state (`h`, `c`) is never reset between sessions**

Silero VAD v5 is an LSTM-based model with hidden state tensors (`h` and `c`). The model in `@ricky0123/vad-web` maintains these states internally across calls. When `VADProcessor.destroy()` is called and a new instance created, `@ricky0123/vad-web` creates a new ONNX session with zero-initialized hidden state — this is correct. However, when the user calls `pause()` / `start()` cycling (which calls `micVAD.pause()` / `micVAD.start()`), there is no guarantee that hidden states are reset. If the LSTM state carries over stale activations from a previous noisy segment, the model will produce incorrect probabilities for the next speaker. In a **multi-session or multi-speaker medical consultation**, this is a correctness issue.

No API is exposed to force-reset the model's LSTM state without destroying and recreating the `MicVAD` instance.

---

**H-2 — `probabilitySum` / `probabilityCount` accumulate without bound → numerical precision erosion and potential overflow**

`packages/vad/src/processors/VADProcessor.ts:111–112, 366–368`

```111:112:packages/vad/src/processors/VADProcessor.ts
private probabilitySum = 0;
private probabilityCount = 0;
```

```366:368:packages/vad/src/processors/VADProcessor.ts
this.probabilitySum += probabilities.isSpeech;
this.probabilityCount++;
this.stats.averageSpeechProbability = this.probabilitySum / this.probabilityCount;
```

At 512 samples/frame and 16 kHz, Silero v5 produces ~31.25 frames/second. After 8 hours of continuous operation (a long medical consultation), `probabilityCount` = 900,000. JavaScript `Number` (IEEE 754 double) can hold this without integer overflow, but `probabilitySum` accumulates ~450,000 (if average probability is ~0.5), and the running division will lose precision at large counts. More critically, `resetStats()` resets both to 0 but the user has no automatic mechanism — stats can silently become less accurate over time.

A sliding window average (e.g., last 1000 frames) would be correct and memory-safe.

---

**H-3 — `postSpeechPadMs` is passed to `MicVAD` but `vad-web@0.0.30` may not expose this parameter on `RealTimeVADOptions`**

`packages/vad/src/processors/VADProcessor.ts:170`

```170:170:packages/vad/src/processors/VADProcessor.ts
        postSpeechPadMs: this.options.postSpeechPadMs,
```

The `RealTimeVADOptions` type from `@ricky0123/vad-web` has `preSpeechPadMs` but `postSpeechPadMs` handling varies between versions. If the library silently ignores an unknown property, the post-speech padding configured by the user is simply dropped without error, producing truncated speech segments. The VAD README and `DEFAULT_VAD_OPTIONS` document `postSpeechPadMs: 300` as a supported default, but the actual effect depends entirely on `vad-web` support.

---

**H-4 — `duration` field does not exist on `VADSpeechEndPayload`; example code will always print `undefined`ms**

`packages/vad/examples/transcription-integration.ts:78–85`

```78:85:packages/vad/examples/transcription-integration.ts
const { audio, startTime, endTime, duration } = payload.data as {
  audio: Float32Array;
  startTime: number;
  endTime: number;
  duration: number;
};
console.log(`[VAD] Speech ended - ${duration}ms`);
```

`VADSpeechEndPayload` (`src/types/index.ts:252–287`) has no `duration` field — it has `durationSec`. The manual `as { ... duration: number }` cast suppresses TypeScript's error. Consuming code will log `undefined ms`. This example is referenced in the README and is the primary integration guidance for new developers.

---

**H-5 — No input sample-rate enforcement / resampling before `MicVAD`**

`VADProcessor.onInit()` receives whatever `MediaStreamTrack` `@arcaai/room` provides. The browser's `AudioContext` may be at 44.1 kHz or 48 kHz. `MicVAD` internally resamples to 16 kHz via its own worklet. However, the `sampleRate` option passed into `MicVAD` in `VADProcessor` is always 16000 (from `DEFAULT_VAD_OPTIONS`) regardless of the actual `AudioContext.sampleRate`.

```173:173:packages/vad/src/processors/VADProcessor.ts
        sampleRate: this.options.sampleRate,
```

If `@ricky0123/vad-web` interprets this field as the input sample rate (it does not in current versions but may in future), it will apply the wrong resampling ratio. The field should reflect `audioContext.sampleRate` (the actual input rate), not the model's target rate.

---

### MEDIUM

---

**M-1 — `updateThresholds()` silently does nothing at runtime**

`packages/vad/src/processors/VADProcessor.ts:500–506`

```500:506:packages/vad/src/processors/VADProcessor.ts
async updateThresholds(positiveSpeechThreshold: number, negativeSpeechThreshold: number): Promise<void> {
  this.options.positiveSpeechThreshold = positiveSpeechThreshold;
  this.options.negativeSpeechThreshold = negativeSpeechThreshold;
  // Note: vad-web doesn't support runtime threshold updates,
  // would need to restart with new options
}
```

The method updates `this.options` but `MicVAD` continues using the original thresholds. `VADFramePayload.isSpeech` is then computed from the local threshold:

```375:375:packages/vad/src/processors/VADProcessor.ts
      isSpeech: probabilities.isSpeech > this.options.positiveSpeechThreshold,
```

This creates a split reality: the emitted `vad-frame.isSpeech` boolean reflects the new threshold, but the underlying `vad-speech-start` / `vad-speech-end` events still use the original thresholds baked into `MicVAD`. Callers who rely on `updateThresholds()` to adapt sensitivity during a session (e.g., based on noise level) will get wrong behavior with no error or warning.

For medical consultation (the stated use-case), dynamic sensitivity adaptation is important. The only correct path is to destroy and recreate `MicVAD`. The public API offers no `restart()` method.

---

**M-2 — `useVAD` hook: `processor` in return value is stale on first render**

`packages/vad/src/hooks/useVAD.ts:347`

```340:356:packages/vad/src/hooks/useVAD.ts
  return {
    isActive,
    isSpeaking,
    speechProbability,
    currentSpeechDuration,
    stats,
    processor: processorRef.current,
    ...
  };
```

`processorRef.current` is assigned in a `useEffect` with `[]` deps, which runs after the first render. On the initial render `processorRef.current` is `null`. The returned `processor` value is captured at render time (not reactive), so it always reflects the value at the moment of the render. This is technically correct for a ref-based pattern, but callers who destructure `processor` and memoize it will always hold the initial `null` reference.

---

**M-3 — Double event handling: callbacks fire twice (callback + event listener in `useVAD`)**

`useVAD` creates a `VADProcessor` with inline callbacks (`onSpeechStart`, `onSpeechEnd`, etc.) at line 164–184. It also sets up a `processor.on(ProcessorEvent.Data, handleData)` listener at line 203. Both code paths run for every VAD event. For `vad-speech-start`, `isSpeaking` is set to `true` both by the constructor callback (`line 167`) and by the `handleData` switch case (`line 220`). For `vad-speech-end`, `isSpeaking` is set to `false` in both paths. This causes **two React state updates per event**, doubling re-renders and potentially causing UI flicker.

---

**M-4 — `useVAD` auto-attach silently swallows errors**

`packages/vad/src/hooks/useVAD.ts:315–323`

```314:323:packages/vad/src/hooks/useVAD.ts
  useEffect(() => {
    if (autoAttach && track && !isAttached) {
      attach().catch(console.error);
    }
    if (!track && isAttached) {
      detach().catch(console.error);
    }
  }, [track, autoAttach, isAttached, attach, detach]);
```

Errors from `attach()` are caught and logged to `console.error` only. The `error` state is set inside `attach()` itself, so it is set, but the calling pattern means the UI may not re-render before the user has the chance to see or handle the error condition. More critically, if `attach()` throws before `setError()` is called, the error is completely lost.

---

**M-5 — `VADWorkletInboundMessage` type union is incomplete vs. actual worklet protocol**

`packages/vad/src/types/index.ts:326–331`

```326:331:packages/vad/src/types/index.ts
export type VADWorkletInboundMessage =
  | { type: 'init'; config: VADWorkletConfig }
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'updateThreshold'; positiveSpeechThreshold: number; negativeSpeechThreshold: number }
  | { type: 'getStats' }
  | { type: 'destroy' };
```

The outbound message type `VADWorkletOutboundMessage` (line 347–353) lists `{ type: 'frame'; isSpeech: boolean; probability: number; timestamp: number }` but the worklet actually sends `frameData` too:

`worklet-loader.ts:99–105`:
```javascript
this.port.postMessage({
  type: 'frame',
  isSpeech: this.isSpeaking,
  probability: this.lastProbability,
  timestamp: currentTime * 1000,
  frameData,   // ← not in the type
}, [frameData.buffer]);
```

The `frameData` field is missing from the exported `VADWorkletOutboundMessage` type.

---

**M-6 — `additionalAudioConstraints` option accepted but never used**

`packages/vad/src/types/index.ts:116–119` and `VADProcessor.ts:145`

```116:119:packages/vad/src/types/index.ts
  additionalAudioConstraints?: Partial<MediaTrackConstraints>;
```

The option is stored in `this.options.additionalAudioConstraints` but is never passed to `getUserMedia` or `MicVAD`. Since the package uses `getStream: async () => stream` (the caller's stream), it could not apply constraints anyway. This is dead configuration.

---

**M-7 — `src/worklets/vad.worklet.ts` compiled to `dist/worklets/` but imports from `../types/index.js`**

```13:13:packages/vad/src/worklets/vad.worklet.ts
import type { VADWorkletInboundMessage, VADWorkletOutboundMessage, VADWorkletConfig, VADStats } from '../types/index.js';
```

The worklet is compiled by tsup to `dist/worklets/vad.worklet.js`. When loaded via `audioWorklet.addModule()`, the AudioWorklet global has no module resolver — it runs as an isolated script. Type-only imports are erased at compile time so this is safe for the *current* state, but if anyone adds a value import from `../types/`, it will fail silently at the blob URL boundary or with a network error. This is a fragile design.

---

**M-8 — `isSafariAudioWorkletSupported()` has inverted logic**

`packages/vad/src/utils/browserSupport.ts:92–94`

```92:94:packages/vad/src/utils/browserSupport.ts
export function isSafariAudioWorkletSupported(): boolean {
  return isSafariVersionSupported() && isSafari();
}
```

The function name means "is Safari AudioWorklet supported", which should return `true` when running on Safari ≥17.4. The body calls `isSafariVersionSupported() && isSafari()`, which is semantically equivalent. However, on non-Safari browsers (`isSafari()` = `false`), it returns `false`, which is *technically* correct for "is Safari AudioWorklet specifically supported" but semantically confusing — on Chrome, the result is `false` even though Chrome has AudioWorklet. The function is only used in `getRecommendedModel()` to fall back to `'legacy'` for old Safari. On non-Safari browsers, `getRecommendedModel()` correctly returns `'v5'` regardless. The function name would be clearer as `isSafariWithAudioWorkletSupport()`. Low impact but misleading.

---

**M-9 — No guard against `negativeSpeechThreshold ≥ positiveSpeechThreshold`**

`VADOptions` allows any floating-point value. If a caller sets `positiveSpeechThreshold: 0.3` and `negativeSpeechThreshold: 0.35`, the hysteresis logic is inverted — frames will switch between speech and non-speech rapidly (chattering). No runtime validation, no warning. The type system allows `negativeSpeechThreshold: 0.99, positiveSpeechThreshold: 0.01`.

---

### LOW

---

**L-1 — `VADWorkletConfig.sampleRate` is never set from `AudioContext.sampleRate`**

`src/types/index.ts:336–342` — `VADWorkletConfig` has a `sampleRate` field. The custom worklet initializer stores it (`this.config.sampleRate`) but never uses it. Frame accumulation in the worklet is sample-count based, not time-based, so sample rate is irrelevant there. The field adds confusion.

---

**L-2 — `audioContext` set to fixed `sampleRate: 16000` in the E2E fixture, which may not be honoured by hardware**

`e2e/fixtures/index.html:450`

```javascript
const audioContext = new AudioContext({ sampleRate: 16000 });
```

Many operating systems clamp the `AudioContext.sampleRate` to a supported hardware rate (44100, 48000). If the context is silently created at 48 kHz, audio will not be resampled before reaching `MicVAD`, and the model processes at the wrong rate, producing silent or wrong VAD. The E2E test at line 706–720 does check `audioInfo.sampleRate` but only asserts `> 0`, not that it equals 16000.

---

**L-3 — `isONNXRuntimeSupported()` is a trivially weak check**

`packages/vad/src/utils/browserSupport.ts:108–111`

```108:111:packages/vad/src/utils/browserSupport.ts
export function isONNXRuntimeSupported(): boolean {
  if (!isWebAssemblySupported()) return false;
  return true;
}
```

This function returns `true` any time WASM is supported. It does not check whether `onnxruntime-web` is importable, whether the model files are reachable, or any ONNX-specific capability. It is effectively an alias for `isWebAssemblySupported()`.

---

**L-4 — `duration` field absent from `VADSpeechEndPayload` type but present in README and examples**

Already noted under H-4 as a code defect, but the README at `packages/vad/README.md:252` shows:

```
const { audio, startTime, endTime, duration } = payload.data;
```

...and the `VADSpeechEndPayload` type has no `duration` field. The README is wrong/stale.

---

**L-5 — `VADProcessor` does not null-guard `destinationNode` disconnect on destroy**

`packages/vad/src/processors/VADProcessor.ts:422–428`

```422:428:packages/vad/src/processors/VADProcessor.ts
    if (this.destinationNode) {
      this.destinationNode = null;
    }
```

`MediaStreamAudioDestinationNode` is set to null but not disconnected. `this.sourceNode.disconnect()` is called (correct), but `destinationNode.disconnect()` is not. While the garbage collector will eventually collect it, explicitly disconnecting ensures no lingering Web Audio graph references.

---

**L-6 — `vitest.setup.ts` `MockAudioContext.sampleRate = 48000` mismatches VAD's expected 16000**

`packages/vad/vitest.setup.ts:11`

```11:11:packages/vad/vitest.setup.ts
  sampleRate = 48000;
```

When tests construct a `VADProcessor` and exercise `onInit`, the mocked audio context reports 48 kHz. The processor stores `this.streamStartWallClock` and creates a `MediaStream([track])` but does not validate sample rate. The mismatch is currently benign because actual inference is mocked out, but it means unit tests do not catch sample-rate-related bugs.

---

**L-7 — `e2e/fixtures/index.html` uses `window.testResults.vadProcessor.onDestroy()` directly**

`e2e/fixtures/index.html:514`

```javascript
await window.testResults.vadProcessor.onDestroy();
```

`onDestroy()` is a `protected` method in `BaseProcessor`. Calling it directly bypasses the `destroy()` public method which presumably sets internal state flags (e.g., marking the processor as not initialized). This is a testing anti-pattern that could mask lifecycle bugs.

---

## 5. Security

### 5.1 Model Load Source Trust (CDN)

Both the Silero ONNX model file (`silero_vad_v5.onnx`) and the `vad.worklet.bundle.min.js` are loaded from `cdn.jsdelivr.net` at runtime with **no subresource integrity (SRI) checksums**. An attacker who compromises jsDelivr (or performs a supply-chain attack on the `@ricky0123/vad-web` npm package) can serve a malicious ONNX model or worklet script. The worklet runs in the AudioWorklet global scope; a malicious worklet can capture raw audio samples and exfiltrate them via `postMessage`. In a medical consultation context this is a HIPAA-relevant threat.

No `integrity=` attribute is possible for dynamically loaded modules (via `audioWorklet.addModule(url)`), but callers can:
- Self-host and validate files at deploy time.
- Use a CSP `script-src` that restricts which origins are allowed.

Neither is documented, enforced, or even mentioned beyond a brief note in `assets/README.md`.

### 5.2 CSP Requirements

The blob-URL worklet pattern (`URL.createObjectURL(new Blob([...]))`) requires `blob:` to be allowed in `worker-src` and `script-src-elem`. The `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers required for `SharedArrayBuffer` (and thus multi-threaded WASM) impose strict cross-origin isolation. The README documents the Vite dev-server config for COOP/COEP but does not document the CSP policy required in production. Applications without `blob:` in `worker-src` will fail silently (the module will be registered but the worklet will throw a policy violation).

### 5.3 `@ricky0123/vad-web` as Opaque Dependency

The `MicVAD.new()` call internally loads additional resources (its own worklet bundle from CDN) and creates an ONNX inference session. These actions are invisible to `VADProcessor`'s error handling — if `MicVAD` internally catches its own errors, `VADProcessor.initMicVAD()` may not throw even if initialization is incomplete:

```265:271:packages/vad/src/processors/VADProcessor.ts
    } catch (error) {
      throw new VADError(
        VADErrorCode.MODEL_LOAD_FAILED,
        `Failed to initialize MicVAD: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error : undefined,
      );
    }
```

This outer catch only catches errors that `MicVAD.new()` propagates. Internal retry logic or silent fallbacks inside `vad-web` are invisible.

---

## 6. Performance

### 6.1 Latency

At 512 samples per frame at 16 kHz, each Silero v5 inference covers 32 ms of audio. The latency from speech start to detection is at minimum one frame (32 ms) plus ONNX inference time. With WASM single-threaded on a mid-range mobile device, inference is ~5–15 ms/frame. Total latency: ~37–47 ms. This is acceptable for push-to-talk but borderline for real-time transcription UI.

With SharedArrayBuffer + multi-threaded WASM (`numThreads > 1`), inference could drop to ~5 ms. However, this is gated on COOP/COEP which is not always feasible (e.g., when embedding third-party iframes). The package does not document or configure thread count.

### 6.2 CPU Usage on Low-End Devices

The `preSpeechPadMs: 300` default means 300 ms of audio (4,800 samples at 16 kHz, ~9 v5 frames) are buffered continuously. The `AudioRingBuffer` is designed for this. On low-end devices, a continuous frame-processing loop at 31.25 Hz is generally manageable for WASM ONNX, but the package provides no power-saving mechanism (e.g., pausing inference when audio level is below a noise floor threshold before even running the model).

### 6.3 ONNX WebGPU Fallback

There is **no WebGPU backend configuration** anywhere in the codebase. `@ricky0123/vad-web` as of `0.0.30` does not expose WebGPU backend selection. `onnxruntime-web@1.24.x` ships WebGPU support, but it requires explicit opt-in via `ort.env.webgpu = true` and the `wasm/webgpu` backend. This is not configured, not documented, and not available to consumers through the current API. For medical-grade inference on high-end devices (e.g., M-series Macs), this is a missed 5–10× performance opportunity.

### 6.4 Frame Transfer Overhead

The custom worklet correctly uses transferable buffers:

```134:143:packages/vad/src/worklets/vad.worklet.ts
        this.port.postMessage(
          { ..., frameData },
          [frameData.buffer],     // ← transferable
        );
```

However, since `VADProcessor` never listens for these messages (defect C-3), the transferred buffer is immediately GC'd. The allocation of `new Float32Array(this.frameBuffer)` (512 floats = 2 KB) on every frame (31.25×/sec = ~64 KB/sec) is unnecessary copying.

---

## 7. Test Coverage Gaps

| Gap | File | Severity |
|---|---|---|
| `onInit()` integration path never tested | `VADProcessor.test.ts` | High |
| `onDestroy()` cleanup path never tested | `VADProcessor.test.ts` | High |
| `onEnable()` / `onDisable()` never tested | `VADProcessor.test.ts` | Medium |
| Speech start/end/misfire callbacks never invoked in tests | `VADProcessor.test.ts` | High |
| `initMicVAD()` error paths (`MODEL_LOAD_FAILED`) not tested | `VADProcessor.test.ts` | Medium |
| `startStatsEmission()` / `stopStatsEmission()` not tested | `VADProcessor.test.ts` | Medium |
| `handleFrameProcessed()` `averageSpeechProbability` accumulation not tested | `VADProcessor.test.ts` | Medium |
| `useVAD` hook never rendered with `renderHook()` — all tests are structural type checks | `useVAD.test.ts` | High |
| Auto-attach behavior (`autoAttach: true` with a real track) never tested | `useVAD.test.ts` | High |
| Detach on track removal never tested | `useVAD.test.ts` | Medium |
| `Resampler` carry-over state across chunk boundaries has limited coverage | `resampler.test.ts` | Low |
| `browserSupport` tests only verify return types, not actual values (jsdom has incomplete API surface) | `browserSupport.test.ts` | Low |
| `VADError.cause` not tested in error propagation from `initMicVAD` | `VADProcessor.test.ts` | Low |
| E2E tests skip most assertions when module is not built | `vad.e2e.spec.ts` | High |
| No E2E test for cross-origin isolation + SharedArrayBuffer path | `vad.e2e.spec.ts` | Medium |
| No test for `pause()` → `start()` → LSTM state behavior | — | High |
| No test for threshold validation (`neg ≥ pos`) | — | Medium |
| No test for `postSpeechPadMs` actually being applied | — | Medium |

---

## 8. Conformance to 2026 Best Practices

### 8.1 ONNX Runtime Web 1.24+

`onnxruntime-web@1.24.3` is listed in `devDependencies`. This version ships:
- WebGPU backend (`ort.env.webgpu = true`)
- `ort.env.wasm.numThreads` for explicit thread control
- `ort.env.wasm.proxy` for off-main-thread inference
- Improved WASM SIMD support

None of these are configured or exposed. The package treats ORT as a black box behind `vad-web`.

### 8.2 Silero v6 Availability

As of early 2026, Silero VAD v5 remains current in `@ricky0123/vad-web`. Silero v6 has not been publicly released in ONNX form for browser inference. The `model: 'v5' | 'legacy'` union is appropriate for now, but `@ricky0123/vad-web` should be monitored for v6 model support.

### 8.3 Transferable Buffers

`Float32Array` frames are transferred correctly (defect C-3 notwithstanding). `Float32Array` → `AudioWorkletProcessor` via `port.postMessage(data, [data.buffer])` is correct per the spec.

### 8.4 Worklet vs Worker

The package correctly uses `AudioWorklet` for frame accumulation (audio thread) and delegates inference to `@ricky0123/vad-web` (which uses a Dedicated Worker for ONNX sessions). This is architecturally correct for 2026. The Web Audio specification discourages `ScriptProcessorNode`, but the package includes it as a fallback detection path in browser support.

### 8.5 WebGPU

No WebGPU configuration exists. As of 2026, Chrome 128+ has WebGPU enabled by default, Safari 17.4+ has WebGPU available, and Firefox is advancing. For medical-grade real-time VAD on capable hardware, WebGPU inference would halve latency. This is a missed opportunity, not yet a defect.

---

## 9. Refactor / Improvement Suggestions

### 9.1 Critical: Fix CDN version alignment

Update `DEFAULT_BASE_ASSET_PATH` and `DEFAULT_ONNX_WASM_BASE_PATH` to match the installed package versions, and derive them programmatically rather than hard-coding:

```typescript
// In a build-time constant or via a manifest approach:
const DEFAULT_BASE_ASSET_PATH = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`;
const DEFAULT_ONNX_WASM_BASE_PATH = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/`;
```

Or, better: document that the caller **must** provide `baseAssetPath` and `onnxWASMBasePath` explicitly, and make the CDN defaults warn on first use.

### 9.2 Critical: Eliminate the dead custom worklet

Delete `src/worklets/vad.worklet.ts`, the blob-URL generator in `worklet-loader.ts`, and the `@arcaai/vad/worklet` entry point. Expose only `WORKLET_PROCESSOR_NAME` and `isVADWorkletRegistered()` if needed for external tooling. This removes ~300 lines of dead, misleading code and two exported APIs that do nothing.

### 9.3 High: Expose `MicVAD` restart for threshold/session reset

Add a `restart()` method that calls `micVAD.pause(); micVAD.destroy();` and re-calls `initMicVAD(this.stream)`. This ensures hidden-state reset and proper threshold propagation:

```typescript
async restart(newOptions?: Partial<VADOptions>): Promise<void> {
  if (newOptions) Object.assign(this.options, newOptions);
  if (this.micVAD) { this.micVAD.pause(); this.micVAD.destroy(); }
  await this.initMicVAD(this.stream);
}
```

### 9.4 High: Sliding-window average probability

Replace unbounded accumulation with a circular buffer of the last `N` (e.g., 1000) frame probabilities:

```typescript
private probWindow = new Float32Array(1000);
private probWindowIdx = 0;
private probWindowCount = 0;

// In handleFrameProcessed:
this.probWindow[this.probWindowIdx] = p;
this.probWindowIdx = (this.probWindowIdx + 1) % 1000;
this.probWindowCount = Math.min(this.probWindowCount + 1, 1000);
this.stats.averageSpeechProbability = this.probWindow
  .slice(0, this.probWindowCount)
  .reduce((a, b) => a + b, 0) / this.probWindowCount;
```

### 9.5 Medium: Fix `VADSpeechEndPayload` — add `duration` field or fix examples

Add `duration: number` (in ms) to `VADSpeechEndPayload` for convenience, or fix all examples and the README to use `durationSec`:

```typescript
// In types/index.ts
export interface VADSpeechEndPayload {
  ...
  durationSec: number;
  duration: number; // milliseconds — convenience alias
}
```

### 9.6 Medium: Threshold validation

```typescript
if (positiveSpeechThreshold <= negativeSpeechThreshold) {
  throw new VADError(VADErrorCode.INVALID_CONFIG,
    `positiveSpeechThreshold (${positiveSpeechThreshold}) must be > negativeSpeechThreshold (${negativeSpeechThreshold})`);
}
```

### 9.7 Medium: Dedup event handling in `useVAD`

Remove the constructor-callback pattern from the `VADProcessor` instantiation inside `useVAD`. Use only the `processor.on(ProcessorEvent.Data, handleData)` listener. Store callback refs and call them from inside `handleData`:

```typescript
case 'vad-speech-start':
  setIsSpeaking(true);
  callbacksRef.current.onSpeechStart?.();
  break;
```

This halves the number of React state updates per VAD event.

### 9.8 Medium: Add threshold personalization API for medical use

For a medical consultation platform, static thresholds are inadequate. Provide a simple calibration mode:

```typescript
async calibrate(durationMs = 2000): Promise<{ recommendedPositiveThreshold: number }> {
  // Collect N frames of non-speech audio, compute 95th percentile probability
  // Return a recommended positive threshold = p95 + 0.1
}
```

This enables per-session (or per-speaker) threshold adaptation.

### 9.9 Low: Self-hosted asset integrity verification

Document SHA-384 checksums for all CDN-hosted files and provide a CLI helper to download and verify them:

```bash
pnpm vad:download-assets --verify
```

### 9.10 Low: Expose `ort.env` configuration pass-through

```typescript
interface VADOptions {
  ortEnv?: {
    numThreads?: number;   // ort.env.wasm.numThreads
    useWebGPU?: boolean;   // ort.env.webgpu = true
  };
}
```

This gives advanced callers control over ONNX Runtime backends without breaking the default single-threaded WASM path.

---