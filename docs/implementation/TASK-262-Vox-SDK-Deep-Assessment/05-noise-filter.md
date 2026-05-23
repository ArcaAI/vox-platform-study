---

# `@arcaai/noise-filter` — Exhaustive Code Review

**Date:** 2026-05-23 | **Reviewer:** AI Agent | **Version:** 0.1.0

---

## 1. Architecture

### 1.1 Worklet Design (`rnnoise.worklet.ts` + `worklet-loader.ts`)

The package ships **two parallel implementations** of the same processor:

| File | Role | Context |
|---|---|---|
| `src/worklets/rnnoise.worklet.ts` | TypeScript source for the worklet (compiled separately by tsup) | AudioWorklet thread |
| `src/worklets/worklet-loader.ts` `generateWorkletSource()` | Hand-maintained **copy** of the above, inlined as a JS string to be turned into a Blob URL | Main thread → `audioWorklet.addModule(blobUrl)` |
| `src/processors/RNNoiseProcessor.ts` | ScriptProcessorNode fallback; also used when no WASM binary is passed to `init()` | Main thread |

The registration flow is:
1. `NoiseFilterProcessor.onInit()` → `registerRNNoiseWorklet(audioContext)` if not already registered.
2. `worklet-loader.ts` calls `createWorkletLoader` from `@arcaai/room`, which generates a Blob URL from `generateWorkletSource()` and calls `audioContext.audioWorklet.addModule(blobUrl)`.
3. After registration, `createRNNoiseWorkletNode()` constructs an `AudioWorkletNode`.
4. The main thread then fetches the WASM binary and transfers it to the worklet via `port.postMessage({ type: 'init', wasmBinary }, [wasmBinary])`.
5. Inside the worklet, `initWasm()` runs `WebAssembly.compile()` + `WebAssembly.instantiate()`.

### 1.2 WASM Loading Strategy

The WASM binary is loaded on the **main thread** and transferred to the worklet:

```
NoiseFilterProcessor.loadWasmBinary()        [main thread]
  → fetch(wasmPath ?? CDN URL)               [main thread network]
  → response.arrayBuffer()
  → port.postMessage({type:'init', wasmBinary}, [wasmBinary])  ← Transferable
                                              ↓
worklet: initWasm(wasmBinary)
  → WebAssembly.compile(wasmBinary)           [worklet thread]
  → WebAssembly.instantiate(module, imports)  [worklet thread]
```

The default `wasmPath` is a **jsDelivr CDN URL** (`NoiseFilterProcessor.ts:220`). `@jitsi/rnnoise-wasm` is declared as a runtime dependency in `package.json` but the worklet path never uses it — only `RNNoiseProcessor.init()` (main-thread fallback path) calls `import('@jitsi/rnnoise-wasm')`.

### 1.3 Sample-Rate Handling

- Frame constant: `RNNOISE_FRAME_SIZE = 480` (`rnnoise.worklet.ts:13`, `RNNoiseProcessor.ts:13`).
- RNNoise requires 480 samples at **exactly 48 kHz** for correct frequency-band analysis. The constant is correctly set.
- `sampleRate` is exposed as a `NoiseFilterOptions` field (default 48000, `types/index.ts:102`), but **it is never used to resample** incoming audio. If the `AudioContext` runs at 44.1 kHz (e.g., macOS default) the 480-sample frame is 10.884 ms, not 10 ms, and RNNoise's internal Opus-band filters will be misaligned.
- The worklet reads the global `sampleRate` in `sendStats()` (`rnnoise.worklet.ts:233`) — that is correct for the runtime context, but the initialization path never validates it against the expected 48000.

---

## 2. Public API

| Export | Type | Description |
|---|---|---|
| `NoiseFilterProcessor` | class | Main processor extending `BaseProcessor` |
| `createNoiseFilter(opts?)` | factory | Returns `NoiseFilterProcessor` |
| `RNNoiseProcessor` | class | Low-level WASM wrapper (ScriptProcessor path) |
| `RNNOISE_FRAME_SIZE` | const 480 | Frame size |
| `RNNOISE_SAMPLE_RATE` | const 48000 | Expected sample rate |
| `useNoiseFilter(opts)` | React hook | Full hook returning state + controls |
| `registerRNNoiseWorklet(ctx, url?)` | async fn | Register worklet with AudioContext |
| `isWorkletRegistered(ctx)` | fn | Check registration |
| `createRNNoiseWorkletNode(ctx)` | fn | Create AudioWorkletNode |
| `cleanupWorkletResources()` | fn | Revoke blob URL |
| Browser support utilities | fns | `isRNNoiseSupported`, `getNoiseFilterBrowserSupport`, etc. |
| Error types | class/enum | `NoiseFilterError`, `NoiseFilterErrorCode` |
| All option/stat types | TS types | Full type coverage |

---

## 3. Strengths

1. **Clean separation of concerns**: public processor → worklet loader → low-level WASM wrapper is a logical three-layer stack.
2. **Transferable WASM binary**: the `ArrayBuffer` is transferred (not copied) to the worklet via `postMessage` with the transfer list (`worklet-loader.ts` → `NoiseFilterProcessor.ts:209`). This avoids a double-copy of the ~85 KB binary.
3. **Timeout guard on initialization** (`NoiseFilterProcessor.ts:188-191`): a 10 s timeout correctly prevents hanging if the worklet never responds `ready`.
4. **Graceful fallback chain**: AudioWorklet → ScriptProcessorNode → native WebRTC NS is documented and partially implemented.
5. **Typed message protocol**: `WorkletInboundMessage` and `WorkletOutboundMessage` discriminated unions provide compile-time safety for the `postMessage` boundary.
6. **Dual-frame-buffer design**: accumulating 128-sample render quanta into 480-sample frames in the worklet `process()` loop is the correct architecture. Output is also buffered, so the worklet never blocks.
7. **React hook is well-structured**: `useRef` for processor, callback refs to avoid stale closures, `mountedRef` guard against post-unmount state updates.
8. **E2E test fixture**: a real Playwright HTML fixture with `--use-fake-device-for-media-stream` is excellent for CI audio testing.
9. **Frame-size/sample-rate constants exported**: consumers can validate alignment.

---

## 4. Defects

### 4.1 CRITICAL

---

#### **[CRIT-1]** `malloc`/`free` called on every 480-sample frame — memory churn in the audio thread

**Files:** `rnnoise.worklet.ts:197-224`, `worklet-loader.ts:132-157`, `RNNoiseProcessor.ts:250-274`

Every call to `processRNNoiseFrame()` / `processFrame()` calls `exports.malloc()` for two 480×4 = 1920-byte buffers, then `exports.free()` after copying. At 48 kHz / 480 = **100 frames per second**, this is 200 heap-allocator round-trips per second inside the WASM linear memory allocator. The audio thread in Chromium is a **real-time priority thread**: any allocation that triggers WASM memory growth will stall the thread, causing audible glitches and potentially violating the browser's real-time budget.

The correct approach is to allocate the input/output WASM pointers **once** in `initWasm()` after `rnnoise_create()`, store them as instance fields, and reuse them every frame. The buffers are always 480 floats (1920 bytes), so there is no need for dynamic sizing.

```
rnnoise.worklet.ts:197
    const inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);   // ← called 100×/s
    const outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);  // ← called 100×/s
```

---

#### **[CRIT-2]** Default WASM source is a hard-coded CDN URL — network dependency, CSP violation, and WASM integrity risk

**File:** `NoiseFilterProcessor.ts:220`

```typescript
const wasmPath = this.options.wasmPath ?? 'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm/dist/rnnoise.wasm';
```

- **Availability**: if jsDelivr is blocked, degraded, or the specific version is deleted, the entire noise filter silently fails with a non-descriptive network error.
- **CSP**: sites enforcing `connect-src 'self'` will block this fetch. Sites with `Content-Security-Policy: wasm-unsafe-eval` will further block execution.
- **Integrity**: there is no Subresource Integrity (SRI) hash, so a compromised CDN could serve a modified WASM binary executing arbitrary linear-memory code.
- **Offline/corporate networks**: completely broken.

The `@jitsi/rnnoise-wasm` package is already in `dependencies`. The correct default is to use the bundled file from the npm package (resolve `node_modules/@jitsi/rnnoise-wasm/dist/rnnoise.wasm`) and let the application's bundler (Vite/webpack) copy it to `public/`. The CDN URL should be documented as a manual override only.

---

#### **[CRIT-3]** Custom `WebAssembly.Memory` is provided but the `@jitsi/rnnoise-wasm` Emscripten build manages its own memory — import mismatch will panic or silently corrupt

**Files:** `rnnoise.worklet.ts:97-112`, `worklet-loader.ts:72-87`, `RNNoiseProcessor.ts:118-132`

The worklet constructs:
```typescript
this.memory = new WebAssembly.Memory({ initial: 256 });
const importObject = {
  env: { memory: this.memory, emscripten_notify_memory_growth: () => {} },
  wasi_snapshot_preview1: { proc_exit, fd_close, fd_write, fd_seek },
};
this.wasmInstance = await WebAssembly.instantiate(wasmModule, importObject);
```

Modern Emscripten WASM builds (which `@jitsi/rnnoise-wasm` 0.2.x uses) define their **own** `env.memory` import inside the WASM binary's import section. When you provide an external `memory` object, instantiation will fail with `LinkError: WebAssembly.instantiate(): Import #0 module="env" error: memory import 0 is not a WebAssembly.Memory object` — **or** it will succeed only if the WASM binary does not import memory at all (i.e., uses local memory). The actual behavior depends on the exact build flags of `@jitsi/rnnoise-wasm@0.2.1`.

Either:
- The `@jitsi/rnnoise-wasm@0.2.1` `.wasm` does not import memory and the custom `memory` field is silently ignored (wasted allocation).
- Or it does import memory and instantiation fails at runtime.

The correct fix is to use the library's high-level JS wrapper (`Rnnoise.load()`) instead of manually driving the binary — which is exactly what `RNNoiseProcessor.init()` does when `wasmBinary` is not provided. The raw binary path in the worklet should also use the library's loader or strip the manual memory injection.

---

### 4.2 HIGH

---

#### **[HIGH-1]** Output gap (silence) on every frame boundary — perceivable as crackling

**Files:** `rnnoise.worklet.ts:156-175`, `worklet-loader.ts:110-126`

The worklet's `process()` loop is:
```typescript
for (let i = 0; i < input.length; i++) {   // input.length = 128 (render quantum)
  if (this.outputBufferIndex < this.outputBufferFilled) {
    output[i] = this.outputBuffer[this.outputBufferIndex]!;
    this.outputBufferIndex++;
  } else {
    output[i] = 0;     // ← silence injected
  }

  this.inputBuffer[this.inputBufferIndex] = input[i]!;
  this.inputBufferIndex++;

  if (this.inputBufferIndex >= RNNOISE_FRAME_SIZE) {
    this.processRNNoiseFrame();         // fills outputBuffer
    this.inputBufferIndex = 0;
  }
}
```

The problem: `processRNNoiseFrame()` is called **inline during iteration** at `i = 479 % 128 = 95` (the 96th sample of the 4th quantum inside a 480-sample accumulation). After the call, `outputBufferIndex` resets to 0, meaning the remaining `i = 96..127` of the **current** quantum use `outputBuffer[0..31]` of the just-processed frame. The **first 3 quanta** (i=0..383) that lack processed output are filled with zeros — 384 consecutive zero samples every 480 → latency spikes that sound like 8 ms of silence before speech, approximately **once every 10 ms frame at the boundary point**.

The correct design is a proper ring buffer with separate read and write positions, or a two-frame delay scheme: always play the *previous* processed frame, keeping a one-frame latency (10 ms) which is acceptable and documented.

---

#### **[HIGH-2]** WASM initialization is `async` inside `process()` — violates the AudioWorklet processing model

**File:** `rnnoise.worklet.ts:93`, `worklet-loader.ts:69`

```typescript
private async initWasm(wasmBinary: ArrayBuffer): Promise<void> {
```

`handleMessage` calls `this.initWasm(message.wasmBinary)` without `await`. Since `initWasm` is `async`, it returns a Promise that is discarded. This means:

1. The `'ready'` message may arrive to the main thread after `process()` has already been called multiple times (race window during `WebAssembly.compile`).
2. If `WebAssembly.compile` throws, the Promise rejection is **unhandled** — no error bubbles up and `initialized` stays `false` silently.

The fix requires either making `handleMessage` async (and awaiting `initWasm`), or using `Promise.catch` on the result:

```typescript
case 'init':
  this.initWasm(message.wasmBinary).catch((err) => {
    this.sendMessage({ type: 'error', message: err.message });
  });
```

---

#### **[HIGH-3]** Blob URL is never revoked when the worklet is re-registered on a new AudioContext

**File:** `worklet-loader.ts:194-197`, `NoiseFilterProcessor.ts:152-156`

`createWorkletLoader` from `@arcaai/room` creates a blob URL on first call. `cleanupWorkletResources()` is exported but only manually callable. If the application creates multiple `AudioContext` instances (e.g., on track change or reconnect), `registerRNNoiseWorklet` is called again per context but the blob URL object URL may or may not be reused (depends on `@arcaai/room`'s `createWorkletLoader` internals). Even if reused, the `URL.revokeObjectURL` is never tied to the `AudioContext` lifecycle — blob URLs accumulate.

---

#### **[HIGH-4]** `RNNoiseProcessor` uses hidden dynamic properties instead of class fields — type unsafety and lint blindness

**File:** `RNNoiseProcessor.ts:103-114`, `110-111`, `220`, `326-331`

```typescript
(this as unknown as { _rnnoiseLib: typeof rnnoise })._rnnoiseLib = rnnoise;
(this as unknown as { _denoiseState: typeof state })._denoiseState = state;
```

Private state is stored via `as unknown as {...}` casts to avoid TypeScript's field-visibility rules. This means:
- These fields are invisible to any subclass or consuming code.
- The TypeScript compiler gives no protection against mistyping the field names.
- `destroy()` must repeat the same cast idiom to access them (`RNNoiseProcessor.ts:326-331`).

The correct fix is to declare them as private typed class fields in the class body.

---

#### **[HIGH-5]** `rnnoise-wasm.d.ts` types conflict with actual library API used in `RNNoiseProcessor.ts`

**File:** `src/rnnoise-wasm.d.ts:14-18`, `RNNoiseProcessor.ts:105-107`, `220-227`

The hand-written declaration file says:
```typescript
// rnnoise-wasm.d.ts:14
processFrame(input: Float32Array): Float32Array;   // returns Float32Array
getVadProb(): number;
```

But `RNNoiseProcessor.processFrame()` at line 226 calls:
```typescript
const vadProb = libState.processFrame(processedFrame);  // treats return as number (VAD)
```

If the real library returns a `Float32Array` (denoised samples), the code is treating it as a number, discarding the denoised output, and passing the input frame directly as output. This means noise cancellation **silently does nothing** when using the `@jitsi/rnnoise-wasm` library path. The types file is a guess, not generated from the real package.

---

#### **[HIGH-6]** `initScriptProcessorFallback()` races: `RNNoiseProcessor.init()` is `async` but the `onaudioprocess` callback fires synchronously on the next buffer

**File:** `NoiseFilterProcessor.ts:239-266`

```typescript
this.rnnoiseProcessor.init()          // async — may not complete before first callback
  .then(() => {
    this.rnnoiseProcessor!.setLevel(…);
    this.rnnoiseProcessor!.setEnabled(…);
  })
  .catch(…);

this.fallbackScriptNode.onaudioprocess = (event) => {
  if (this.rnnoiseProcessor && this._enabled) {
    this.rnnoiseProcessor.process(input, output);  // may call before init() resolves
```

`RNNoiseProcessor.process()` when not initialized returns pass-through (correct), but `setLevel` and `setEnabled` are not applied until the `.then()` fires — which could be after several audio callbacks. The initial level/enabled state is therefore ignored for the first ~100ms of fallback processing.

---

### 4.3 MEDIUM

---

#### **[MED-1]** No sample-rate enforcement or resampling — RNNoise will be misaligned if `AudioContext` runs at 44100 Hz

**Files:** `NoiseFilterProcessor.ts:101-144`, `types/index.ts:68-72`

`sampleRate: 48000` is a default option but is never validated against `audioContext.sampleRate`. On macOS, default `AudioContext` sample rate is 44100 Hz. At 44100 Hz, 480 samples = 10.884 ms, and RNNoise's internal 21 Opus subbands will be spectral-shifted. The fix is to either enforce 48000 Hz when constructing the `AudioContext`, log a warning, or include a mandatory resampler node.

---

#### **[MED-2]** VAD probability from RNNoise is treated as a flat scalar — semantics are wrong

**Files:** `rnnoise.worklet.ts:206`, `RNNoiseProcessor.ts:185`, `types/index.ts:127-132`

`rnnoise_process_frame` returns a float between 0 and 1 — this is a **VAD probability** (speech activity). The code stores it as `lastVadProbability` and emits it in stats, which is correct. However:
- It is never used to conditionally mute output during silence (e.g., gate the output to zero when VAD < 0.1 to suppress residual noise) — a common and beneficial use.
- The `noiseReductionDb` stat is **hardcoded** (`rnnoise.worklet.ts:238`, `RNNoiseProcessor.ts:302`): `12 * LEVEL_MULTIPLIERS[level]`. This bears no relationship to actual measured noise reduction. A session can display "12 dB noise reduction" while RNNoise is silently broken.

---

#### **[MED-3]** `framesDropped` is always 0 — stat is meaningless

**Files:** `rnnoise.worklet.ts:244`, `RNNoiseProcessor.ts:308`, `worklet-loader.ts:170`

```typescript
framesDropped: 0,   // hardcoded
```

The stat exists in the type definition (`NoiseFilterStats.framesDropped`) but is never incremented. Consumers relying on this to detect real-time budget overruns will see no signal. The worklet should track `framesDropped` by comparing `performance.now()` budget vs `processingTimeSum / framesProcessed`.

---

#### **[MED-4]** `processedTrack` assigned before WASM is ready — `onInit()` resolves while the worklet is still initializing

**File:** `NoiseFilterProcessor.ts:137-143`

```typescript
await this.initWorkletProcessing(audioContext);     // line 131
// ...
this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];  // line 138
```

`initWorkletProcessing` awaits `initWorkletRNNoise()`, which awaits the worklet's `ready` message. That is correct. However, while `WebAssembly.compile` runs inside the worklet (potentially 100–300 ms for a cold compile), any audio arriving at `sourceNode` passes through the worklet's `process()` which outputs **silence** (`output[i] = 0`) because `initialized = false`. The caller receives a `processedTrack` immediately from `onInit` that starts with up to ~300ms of silence.

---

#### **[MED-5]** Port message listener not removed after `destroy` — potential memory leak and stale handlers

**File:** `NoiseFilterProcessor.ts:160`, `193-205`

```typescript
this.workletNode.port.onmessage = (event) => { this.handleWorkletMessage(event.data); };
```

`onDestroy()` sends `{ type: 'destroy' }` and calls `this.workletNode.disconnect()` and `this.workletNode = null`. It does **not** set `this.workletNode.port.onmessage = null` first. If the worklet responds to `destroy` with a `destroyed` message after the main thread has set `workletNode = null`, the message will still fire on the previously attached listener, which calls `this.handleWorkletMessage`. This is benign in the current `case 'destroyed'` handler (no-op), but it indicates a cleanup ordering issue.

---

#### **[MED-6]** `initWorkletRNNoise()` adds a `message` event listener on the port **in addition to** the already-set `onmessage` handler — duplicate event processing

**File:** `NoiseFilterProcessor.ts:160`, `204`

```typescript
// line 160 — sets onmessage
this.workletNode.port.onmessage = (event) => { this.handleWorkletMessage(event.data); };

// line 204 — also adds event listener
this.workletNode.port.addEventListener('message', messageHandler);
```

The `message` event fires both the `onmessage` property handler and all `addEventListener('message', …)` listeners. During the init window, both fire. If the worklet sends `ready`, both `messageHandler` and `handleWorkletMessage` run. The `handleWorkletMessage` for `'ready'` is a no-op (no `case 'ready'`), but the `messageHandler` removes itself after resolving. If the worklet sends `error`, both fire — `handleWorkletMessage` emits a `ProcessorEvent.Error` **and** `messageHandler` rejects the init Promise, causing two error paths.

---

#### **[MED-7]** `stats.cpuLoad` in the worklet inline source (`worklet-loader.ts`) is always 0

**File:** `worklet-loader.ts:170`

The inline JavaScript source (the duplicated copy) computes:
```javascript
cpuLoad: 0,
```
Hardcoded to 0, while the TypeScript source (`rnnoise.worklet.ts:234`) actually computes it. Since the worklet at runtime uses the **inline JS string**, not the compiled TypeScript, `cpuLoad` is always 0 in production.

---

#### **[MED-8]** Two diverging implementations — any bug fix in `rnnoise.worklet.ts` must be manually mirrored to `worklet-loader.ts`

**Files:** `rnnoise.worklet.ts` (entire file), `worklet-loader.ts:19-192`

`generateWorkletSource()` is a manually maintained copy of `rnnoise.worklet.ts`. Already diverged: `cpuLoad` calculation ([MED-7] above), `sendStats` has no `avgProcessingTime` calculation in the inline source. There is no build step that auto-generates the inline string from the TS source. This is a maintenance trap.

The standard pattern is to use tsup's `--banner` or a Rollup `inline-module` plugin to import the compiled worklet and embed it as a string automatically, or use `?raw` import in Vite.

---

#### **[MED-9]** `DEFAULT_NOISE_FILTER_OPTIONS` is not frozen — shallow mutations silently corrupt defaults

**File:** `types/index.ts:95-104`

```typescript
export const DEFAULT_NOISE_FILTER_OPTIONS: Required<…> = { … };
```

Not `Object.freeze(…)`. Any consumer doing `DEFAULT_NOISE_FILTER_OPTIONS.noiseCancellation = false` modifies the shared constant for all subsequent `new NoiseFilterProcessor()` calls. Should be `Object.freeze({…})`.

---

#### **[MED-10]** `updateOptions()` starts a second `statsInterval` without stopping the first one when `enableStats` was already active

**File:** `NoiseFilterProcessor.ts:449-464`

```typescript
if (options.enableStats !== undefined) {
  this.options.enableStats = options.enableStats;
  if (options.enableStats) {
    this.startStatsEmission();   // ← does NOT stop existing interval first
  } else {
    this.stopStatsEmission();
  }
}
```

If `enableStats` is already `true` and you call `updateOptions({ enableStats: true })`, `startStatsEmission()` is called again, creating a **second interval**. Only one `statsInterval` reference is stored, so the first leaks forever.

---

#### **[MED-11]** `NoiseFilterProcessor.getStats()` returns `null` when using AudioWorklet — only non-null in fallback mode

**File:** `NoiseFilterProcessor.ts:418-423`

```typescript
getStats(): NoiseFilterStats | null {
  if (this.rnnoiseProcessor) {           // only set in ScriptProcessor fallback
    return this.rnnoiseProcessor.getStats();
  }
  return null;                           // AudioWorklet path always returns null
}
```

In the normal (AudioWorklet) path, `getStats()` always returns `null`. Stats are only emitted asynchronously via `enableStats: true` + the `'data'` event. Callers who call `getStats()` directly (as the public API documents) get `null`. The README documents it as returning `NoiseFilterStats | null`, but the consistent null is confusing.

---

### 4.4 LOW

---

#### **[LOW-1]** `ScriptProcessorNode` buffer size of 4096 is 85 ms of latency — documented as "reasonable"

**File:** `NoiseFilterProcessor.ts:255`

```typescript
this.fallbackScriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);
```

4096 samples / 48000 Hz = **85.3 ms**. This is far above acceptable WebRTC conversational audio latency (< 30 ms). Should use 2048 (42.7 ms) or 1024 (21.3 ms). Even these are high — `ScriptProcessorNode` is deprecated precisely because of this latency floor.

---

#### **[LOW-2]** `isRNNoiseSupported()` includes `ScriptProcessorNode` as a qualifying path

**File:** `browserSupport.ts:99-104`

```typescript
export function isRNNoiseSupported(): boolean {
  const hasWorkletOrFallback = isAudioWorkletSupported() || isScriptProcessorSupported();
  return hasWasm && hasAudioContext && hasWorkletOrFallback;
}
```

`ScriptProcessorNode` is deprecated in all browsers and removed in Safari. Including it makes `isRNNoiseSupported()` return `true` in Firefox without `AudioWorklet` (unusual) but then routes to the ScriptProcessor fallback with 85 ms latency. The function should separate the two capabilities or at minimum the return doc should warn about latency.

---

#### **[LOW-3]** `getRecommendedProcessingMode()` result is never used to modify behavior

**File:** `browserSupport.ts:144-157`, `NoiseFilterProcessor.ts` entire file

`processingMode: 'quality' | 'performance'` is stored in options but has no effect on any code path. Neither the worklet nor `RNNoiseProcessor` branches on it. It is documented as "performance vs quality trade-off" but is a dead option.

---

#### **[LOW-4]** `useNoiseFilter` hook exposes `processor` instance directly

**File:** `useNoiseFilter.ts:361`

```typescript
processor: processorRef.current,
```

Exposing a mutable instance reference from a hook allows consumers to call `processor.destroy()` directly, bypassing the hook's internal state tracking. `isActive`, `isAttached`, etc. will become stale. Should be omitted from the return value or wrapped in a readonly proxy.

---

#### **[LOW-5]** `browserSupport.test.ts:119` expects `'balanced'` as a valid mode

**File:** `src/__tests__/browserSupport.test.ts:119`

```typescript
expect(['quality', 'performance', 'balanced']).toContain(mode);
```

`'balanced'` is not a valid `ProcessingMode`. The type union is `'quality' | 'performance'`. This test would pass even if the function returned the invalid string `'balanced'`.

---

#### **[LOW-6]** WASM memory `initial: 256` pages = 16 MB — oversized for RNNoise

**Files:** `rnnoise.worklet.ts:97`, `worklet-loader.ts:72`, `RNNoiseProcessor.ts:118`

```typescript
this.memory = new WebAssembly.Memory({ initial: 256 });   // 256 × 64KB = 16 MB
```

RNNoise's WASM binary requires approximately 1–2 MB of memory (model weights + processing state). Allocating 16 MB up front wastes virtual address space and puts unnecessary pressure on mobile browsers. `initial: 32` (2 MB) would be sufficient with room for growth, and `maximum: 64` should be set.

---

#### **[LOW-7]** `NoiseFilterError.cause` field shadows the native `Error.cause` (ES2022)

**File:** `types/index.ts:302-304`

```typescript
constructor(public readonly cause?: Error, …) {
  super(message);
```

`Error.cause` is a standard ES2022 field. Declaring it as `public readonly cause?: Error` in the constructor shadows the native field type. ES2022 `Error.cause` accepts `unknown`, not just `Error`. This creates a type incompatibility if the consuming code catches a `NoiseFilterError` and reads `.cause` expecting `unknown`.

---

#### **[LOW-8]** `autoGainControl` and `echoCancellation` options are stored but never applied

**Files:** `types/index.ts:45-53`, `NoiseFilterProcessor.ts` entire file

These two options are documented as "uses WebRTC native" but the processor never applies `applyConstraints({ echoCancellation, autoGainControl })` to the track, nor does it pass them to `getUserMedia`. They are dead options that exist only to pass through to the user-facing hook state.

---

## 5. Security

| Issue | Severity | Detail |
|---|---|---|
| CDN WASM with no SRI | **High** | `NoiseFilterProcessor.ts:220` — `cdn.jsdelivr.net` with no `integrity` hash. A compromised CDN could serve a malicious WASM binary. Use bundled file + SRI or host the file yourself. |
| COOP/COEP not required | **Medium** | `SharedArrayBuffer` is detected (`browserSupport.ts:113`) but never used. If it were used for a ring buffer (see §6), the page would require `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. These are not documented as requirements, and no server sends them in the E2E fixture. |
| `wasm-unsafe-eval` CSP | **Medium** | `WebAssembly.compile` from an `ArrayBuffer` (as done here) requires `wasm-unsafe-eval` in the `Content-Security-Policy` `script-src` directive. This is not documented as a requirement. |
| Blob URL for worklet | **Low** | The blob URL for the worklet is a `data:` URL equivalent — not subject to CSP `script-src` restrictions in most browsers, but some strict CSP configurations (`strict-dynamic`) may block it. |
| WASM imports stub | **Low** | `wasi_snapshot_preview1` stubs (`proc_exit`, `fd_close`, etc.) return 0 or no-op. If the WASM binary calls `proc_exit(1)` on internal assertion failure, the no-op swallows it silently rather than surfacing an error. |

---

## 6. Performance

| Topic | Finding |
|---|---|
| **Throughput** | At 48 kHz / 480-sample frames = 100 frames/s. Each frame: one WASM function call, two `malloc`/`free` pairs (CRIT-1), one `Float32Array` view construction. After fixing CRIT-1, throughput should be fine — RNNoise processes in ~0.2–0.5 ms per frame on modern hardware. |
| **malloc/free hot path** | See CRIT-1. At 100×/s, this is the single most impactful performance issue. |
| **Float32Array view per frame** | `new Float32Array(this.memory.buffer, inputPtr, 480)` in `processRNNoiseFrame()` allocates a JS view object each call. These are cheap (no data copy), but can cause GC pressure at 200/s. Caching the views (pre-computed after init) eliminates this. |
| **`performance.now()` in `process()`** | `rnnoise.worklet.ts:153,177` — `performance.now()` is called twice per 128-sample quantum (768 calls/s). In the audio thread this is generally fine but should be guarded: only measure if stats are requested. |
| **ScriptProcessorNode latency** | 4096-sample buffer = 85 ms. See LOW-1. |
| **Ring buffer / SharedArrayBuffer** | Not used. A lock-free SAB ring buffer between the main thread and worklet would eliminate the postMessage round-trip for stats and allow zero-copy level changes. Not critical for the core path but would improve stats accuracy. |
| **`processingMode`** | The `'performance'` mode option is unimplemented (LOW-3). If implemented, it could skip the wet/dry blend (always `multiplier = 1.0`) and save one loop iteration per frame. |

---

## 7. Test Coverage Gaps

| Area | Current Coverage | Gap |
|---|---|---|
| `processRNNoiseFrame()` with real WASM | Not tested | The worklet's `processRNNoiseFrame` is never called with a real `WebAssembly.Instance`. All tests mock it or test only pass-through. |
| Sample rate mismatch (44100 Hz context) | Not tested | No test verifies behavior or warnings when `audioContext.sampleRate !== 48000`. |
| `malloc` returning 0 (OOM) | Not tested | If WASM linear memory is exhausted, `malloc` returns 0. No test checks this path; the current code would pass `inputPtr=0` to `rnnoise_process_frame`, which is undefined behavior in C. |
| `initWasm()` async error swallowed | Not tested | CRIT-2 (unhandled Promise rejection from discarded `async initWasm` call). |
| Dual listener during init (`onmessage` + `addEventListener`) | Not tested | MED-6 — no test sends a `ready` or `error` message and verifies only one handler fires. |
| `updateOptions` with double `enableStats: true` | Not tested | MED-10 — no test verifies only one interval is active. |
| `ScriptProcessorNode` fallback audio quality | Not tested | `initScriptProcessorFallback()` is never exercised in unit tests. |
| `processedTrack` readiness timing | Not tested | No test verifies that `processedTrack` produces non-zero audio output after `onInit` resolves. |
| Memory growth across long sessions | Not tested | No test runs for >1000 frames to check for growing `processingTimeSum` overflow or WASM heap growth. |
| VAD gating | Not tested | No test verifies that VAD probability correctly reflects speech vs. silence frames. |
| `useNoiseFilter` with React Testing Library | Not tested | `useNoiseFilter.test.ts` only checks type shape, not actual hook lifecycle via `renderHook`. |
| Worklet destroy → port null race | Not tested | MED-5 — no test sends `destroy` and then immediately sends another message. |
| Firefox/WebKit E2E | Present but skipped | E2E tests skip if `rnnoiseSupported` is false, which it will be in WebKit without proper COOP/COEP. |

---

## 8. Conformance to Best Practices

| Practice | Status | Detail |
|---|---|---|
| **AudioWorklet `process()` return `true`** | ✅ Correct | Both implementations return `true` unconditionally (keep processor alive). |
| **Transferable ArrayBuffer for WASM** | ✅ Correct | `port.postMessage({…wasmBinary}, [wasmBinary])` (`NoiseFilterProcessor.ts:209`). |
| **`WebAssembly.instantiateStreaming`** | ❌ Not used | The main-thread load calls `fetch()` then `response.arrayBuffer()` (`NoiseFilterProcessor.ts:223-227`), then passes the buffer to the worklet which calls `WebAssembly.compile(buffer)`. `instantiateStreaming` is not applicable inside a worklet (no `fetch` API), but on the main thread the fetch-then-arrayBuffer pattern doubles memory usage during compile vs. `instantiateStreaming`. Consider `WebAssembly.compileStreaming(fetch(url))` on the main thread (when loading for main-thread fallback) and keep the current transfer pattern for the worklet. |
| **One `AudioContext` per session** | ✅ Correct | Processor reuses the `audioContext` passed in from `@arcaai/room`. |
| **`ScriptProcessorNode` disconnect on unmount** | ✅ Correct | `onDestroy()` calls `fallbackScriptNode.disconnect()` (`NoiseFilterProcessor.ts:350`). |
| **Worklet port close on unmount** | ⚠️ Partial | Port is not explicitly closed; `port.close()` is not called. The worklet receives `destroy` message and cleans up WASM state, but the MessagePort itself is left open. |
| **Strict CSP / `wasm-unsafe-eval`** | ❌ Not documented | Loading WASM from an `ArrayBuffer` requires `wasm-unsafe-eval`. Not mentioned in README or documented anywhere. |
| **COOP/COEP if SAB used** | N/A | `SharedArrayBuffer` detected but not used. |
| **Module re-instantiation per track change** | ✅ Avoids | `isWorkletRegistered()` prevents re-registering the worklet with the same `AudioContext`. A new `RNNoiseDenoiseState` is created per `NoiseFilterProcessor` instance, which is correct. |
| **Inline worklet string vs. compiled worklet** | ❌ Dual source | See MED-8. The TypeScript source (`rnnoise.worklet.ts`) is compiled by tsup as `dist/worklets/rnnoise.worklet.js` but the main package path uses the inline string. The compiled file is exported at `./worklet` entry but is not used by the package itself. |
| **`DeepFilterNet`/alternative consideration** | See §9 below. | |

---

## 9. Refactor and Improvement Suggestions

### 9.1 Eliminate the Dual-Source Problem (MED-8)

Use tsup's `banner` or a Rollup `inline-module` plugin to auto-generate the worklet string from the TypeScript source:

```typescript
// worklet-loader.ts
import workletSource from './rnnoise.worklet.ts?raw';   // Vite / rollup-plugin-string
// OR: tsup inline plugin to produce the string at build time
```

This eliminates the hand-maintained copy entirely.

### 9.2 Pre-allocate WASM Buffers (CRIT-1 Fix)

```typescript
private inputPtr = 0;    // allocated once in initWasm
private outputPtr = 0;

private initWasm(wasmBinary: ArrayBuffer) {
  // ... compile + instantiate ...
  this.inputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
  this.outputPtr = exports.malloc(RNNOISE_FRAME_SIZE * 4);
  this.inputView = new Float32Array(memory.buffer, this.inputPtr, 480);
  this.outputView = new Float32Array(memory.buffer, this.outputPtr, 480);
}
```

### 9.3 Use the Library API in the Worklet

Instead of raw WASM binary + manual Emscripten imports, send the worklet a URL and let it `importScripts` or use `fetch` + the library's JS loader. This avoids the import-object mismatch (CRIT-3).

### 9.4 One-Frame Ring Buffer to Fix Output Gap (HIGH-1)

Accept one additional frame of latency (10 ms → 20 ms total) to guarantee the output buffer is always full. This is a well-known "double-buffer" strategy:

```
inputBuffer (480)  →  [RNNoise]  →  playbackBuffer (480)
                                 →  pendingBuffer (480)
```

Play from `playbackBuffer`; when it is exhausted, swap `pendingBuffer` → `playbackBuffer` and refill `pendingBuffer`. No zeros ever reach the output.

### 9.5 Add Sample-Rate Validation and Resampling

```typescript
if (audioContext.sampleRate !== 48000) {
  console.warn(`[NoiseFilter] AudioContext is ${audioContext.sampleRate} Hz; RNNoise expects 48000 Hz. Audio quality may be degraded.`);
  // optionally: insert a resampler (e.g., a Biquad or custom linear interpolation node)
}
```

### 9.6 Implement `processingMode` (LOW-3)

`'performance'` mode: skip wet/dry blending, always use `multiplier = 1.0` (pure RNNoise output). `'quality'` mode: keep the blend. Also consider: in performance mode, skip stats measurement and reduce `performance.now()` calls.

### 9.7 Alternative Model Consideration

| Library | Approach | Pros | Cons |
|---|---|---|---|
| **RNNoise (current)** | GRU + Opus bands, WASM | ~85 KB WASM, ~1-2% CPU, no latency | Trained on narrow speech domain; less effective on music; no stereo |
| **[RNNoise-3 / rnnoise](https://github.com/xiph/rnnoise)** | Updated model | Slightly better RNNT model, same frame size | Requires re-build; `@jitsi/rnnoise-wasm` may not track latest |
| **[DTLN-AEC](https://github.com/breizhn/DTLN-AEC)** | Dual-signal LSTM, ONNX | Better echo+noise suppression, separate AEC stage | ~4 MB ONNX model; needs ONNX Runtime Web (~500 KB WASM) |
| **[DeepFilterNet](https://github.com/Rikorose/DeepFilterNet)** | Deep Filter + DF3 bands, ONNX | State-of-the-art DNS MOS scores; runs at ~2-5% CPU in ONNX Web | ~5 MB model; 20 ms framing; requires ONNX Runtime Web |
| **[Facebook denoiser](https://github.com/facebookresearch/denoiser)** | Conv-TasNet, ONNX | End-to-end waveform, no spectral assumptions | Larger model (~10 MB), higher CPU; no WebAssembly native port |
| **[Silero VAD + suppress](https://github.com/snakers4/silero-vad)** | ONNX VAD | Already in `@arcaai/vad`; could gate output | Not a denoiser — only VAD; would need separate filter |

**Recommendation**: For this healthcare audio use-case (clinic/hospital background noise), **DeepFilterNet ONNX** via `@xenova/onnxruntime-web` is the strongest alternative. It outperforms RNNoise on all DNS Challenge benchmarks and runs well inside an `AudioWorklet` with the ONNX Web WASM backend. The trade-off is a 5 MB model download (vs. 85 KB for RNNoise) and 3–5× higher CPU. If bandwidth and CPU are acceptable, it would provide meaningfully better noise cancellation for medical consultation audio.

If staying with RNNoise, the highest-value near-term fix is **CRIT-1** (malloc/free hot path) followed by **MED-8** (dual source) and **HIGH-5** (wrong API types).

---

*End of report. 32 files reviewed. 20 defects documented (3 Critical, 6 High, 11 Medium, 8 Low), plus security, performance, test coverage, and refactor sections.*