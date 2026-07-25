# @arcaai/stt — Comprehensive Code Review

**Reviewed:** `packages/stt/` — all 49 files
**Package version:** 0.1.0
**Transformers.js pinned:** `@huggingface/transformers@3.8.1`
**ONNX Runtime Web pinned:** `1.22.0-dev.20250409` (pre-release dev build)

---

## 1. Architecture

### Engine Abstraction

```
STTEngine (interface)
└── BaseEngine (abstract class) — stats, model-ID helper
    ├── WhisperEngine          — direct main-thread Transformers.js pipeline
    └── WhisperWorkerEngine    — proxies all calls to whisper.worker.ts;
                                 falls back to WhisperEngine when Workers unavailable
```

`BaseEngine` (`src/engines/BaseEngine.ts`) holds protected mutable state (`initialized`, `transcribing`, counters) and provides the HF model-ID resolution logic in `getModelId()`. It does not own a pipeline; concrete subclasses do.

`WhisperEngine` (`src/engines/WhisperEngine.ts`) dynamically imports `@huggingface/transformers` and calls `pipeline('automatic-speech-recognition', …)` on the main thread. WebGPU vs WASM selection happens in `resolveDevice()`.

`WhisperWorkerEngine` (`src/engines/WhisperWorkerEngine.ts`) spawns `dist/workers/whisper.worker.mjs` via `new Worker(new URL(…, import.meta.url))`. A `Map<string, PendingRequest>` correlates request IDs to Promises. On worker unavailability it dynamically imports and delegates to `WhisperEngine`.

The worker (`src/workers/whisper.worker.ts`) is a standalone module-worker. It holds a module-level `whisperPipeline` and `currentConfig`. It handles `init | transcribe | destroy | check-cache` messages and implements retry/fallback logic (ONNX numeric error → cache wipe; WebGPU init error → WASM fallback).

### Provider Model

```
STTProvider (interface)
└── BaseSTTProvider (abstract)
    ├── LocalSTTProvider   — wraps WhisperWorkerEngine + AudioBufferManager + LocalSpeakerDiarizer
    └── RemoteSTTProvider  — wraps WebSocketClient + MessageHandler + audio queue
```

`LocalSTTProvider` runs a 500 ms `setInterval` that drains `AudioBufferManager` into the engine; also supports direct `transcribeSegment()` calls for VAD-gated mode.

`RemoteSTTProvider` enqueues `Float32Array` chunks and a 100 ms `setInterval` flushes them as Int16 PCM over the WebSocket when ≥ 1 600 samples (100 ms) are queued.

`LocalSpeakerDiarizer` (`src/providers/LocalSpeakerDiarizer.ts`) is a pure-JS handcrafted diarizer: radix-2 FFT → mel filterbank → DCT-II MFCC → spectral shape descriptors → autocorrelation pitch → cosine-similarity against running centroids.

### STTProcessor

`STTProcessor` (`src/core/STTProcessor.ts`) extends `BaseProcessor` from `@arcaai/room`. It owns a static `localProviderPool: Map<string, LocalSTTProvider>` that keeps the in-browser Whisper model warm across attach/detach cycles. Audio is captured via the deprecated `ScriptProcessorNode` (4096-sample buffer). A `useSTT` React hook (`src/hooks/useSTT.ts`) wraps it.

### WebSocketClient / MessageHandler

`WebSocketClient` (`src/websocket/WebSocketClient.ts`) manages state machine (disconnected → connecting → connected → error), reconnect on non-1000 close codes using linear backoff (delay × attempt), keep-alive ping every 25 s, and connection timeout at 10 s.

`MessageHandler` (`src/websocket/MessageHandler.ts`) is a simple router from `WSInboundMessage` type to callbacks. There is **no EventEmitter**; it holds a single flat callbacks object.

### Audio Resampler

`audioResampler.ts` delegates all sample-rate conversion to `resampleAudio()` from `@arcaai/room`. That function is linear interpolation:

```typescript
// packages/room/src/utils/audioUtils.ts:137-156
const ratio = fromSampleRate / toSampleRate;
const newLength = Math.round(samples.length / ratio);
for (let i = 0; i < newLength; i++) {
  const srcIndex = i * ratio;
  const frac = srcIndex - Math.floor(srcIndex);
  result[i] = samples[floor]! * (1 - frac) + samples[ceil]! * frac;
}
```

---

## 2. Public API

| Export | Type | Notes |
|---|---|---|
| `STTProcessor` | `class extends BaseProcessor` | Primary processor; attach to `AudioTrack` |
| `createSTT(options?)` | factory | Returns `new STTProcessor(options)` |
| `useSTT(options)` | React hook | Full state + lifecycle management |
| `LocalSTTProvider` | `class` | Direct local access |
| `RemoteSTTProvider` | `class` | Direct remote access |
| `BackendSTTProvider` | `class` | Deprecated alias for `RemoteSTTProvider` |
| `WhisperEngine` | `class` | Main-thread engine (exported, used in fallback) |
| `WhisperWorkerEngine` | **not exported** | Internal only — breaks advanced access |
| `WebSocketClient` | `class` | Exported for custom integrations |
| `MessageHandler` | `class` | Exported for custom integrations |
| `AudioBufferManager` | `class` | Exported for manual use |
| `LocalSpeakerDiarizer` | **not exported** | Internal only |
| Utility functions | various | `prepareFloat32ForWhisper`, `int16ToFloat32`, language utils, browser support utils |
| Type exports | full | All interfaces/enums/types exported |

---

## 3. Strengths

1. **Well-structured layered architecture.** Engine → Provider → Processor separation is clean and testable.
2. **Worker isolation by default.** `WhisperWorkerEngine` as the default keeps the main thread free during inference.
3. **Model warm-pool.** `STTProcessor.localProviderPool` correctly prevents repeated model downloads on attach/detach cycles.
4. **Graceful degradation chain.** Worker → main thread → error; WebGPU → WASM; ONNX numeric error → cache wipe → retry.
5. **Audio backpressure awareness.** `isTranscribing` flag in `LocalSTTProvider.processBufferedAudio` prevents queuing multiple transcriptions simultaneously.
6. **Good resampler integration.** Single authoritative `resampleAudio` from `@arcaai/room` used everywhere via `prepareFloat32ForWhisper`.
7. **Comprehensive unit tests.** High coverage on `AudioBufferManager`, `WebSocketClient`, `MessageHandler`, `BaseEngine`, `BaseSTTProvider`, `LocalSpeakerDiarizer`, resampler utilities, and types.
8. **Typed WS protocol.** `WSInboundMessage` and `WSOutboundMessage` discriminated unions catch protocol mismatches at compile-time.
9. **Initial prompt support.** `STTOptions.prompt` is plumbed through to `RemoteProviderConfig`; local path has `TranscribeOptions.prompt` defined — though the prompt is not actually passed to the engine transcribe call today.
10. **`codeSwitching` flag.** Correctly bypasses language locking in both `WhisperEngine.transcribe` and the worker, enabling multilingual conversations.

---

## 4. Defects

### Critical

**C-1: `prompt` option silently dropped for local provider**
`src/core/STTProcessor.ts:479–512` — `LocalProviderConfig` does not include `prompt`. `STTOptions.prompt` is only forwarded to `RemoteProviderConfig` (line 560). In `WhisperEngine.transcribe` and the worker's `transcribe()`, `transcribeOptions` never includes `initial_prompt`. This means the documented `prompt` field (`README.md:250`) has **zero effect on local Whisper inference**. For medical domain use-cases (the primary use-case of this monorepo), the `initial_prompt` mechanism is the primary way to reduce medical terminology hallucination.

**C-2: Audio transferred by copy, not transfer — potential OOM on long sessions**
`src/engines/WhisperWorkerEngine.ts:353–357` — The `postMessage` for `transcribe` sends the `Float32Array` by **structured clone**, not as a `Transferable`:

```typescript
// WhisperWorkerEngine.ts:352-357
this.worker.postMessage({
  type,
  id: requestId,
  payload,
} as WorkerRequest);
```

For a 30-second chunk at 16 kHz, that is a 1.92 MB Float32Array copied on every transcription. Over a 60-minute session with 30 s chunks (120 calls), this copies ~230 MB and the GC pressure compounds. The fix is `{ transfer: [payload.audio.buffer] }` on the `postMessage` call (the worker already treats audio as read-only).

**C-3: `ScriptProcessorNode` is deprecated; causes audio glitches and may be removed**
`src/core/STTProcessor.ts:590–591`:

```typescript
this.scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
```

`ScriptProcessorNode` is deprecated in the Web Audio spec and MDN explicitly says browsers may remove it. It runs on the main thread, causes audio dropouts, and fires at 4096-sample intervals (≈93 ms at 44.1 kHz), meaning chunks are larger than necessary before resampling. The replacement is `AudioWorkletNode`. An `AudioWorkletProcessor` would run off-main-thread and is already the pattern used by `@arcaai/vad` and `@arcaai/noise-filter` in this monorepo.

---

### High

**H-1: No WebSocket auth — token leakage risk in remote mode**
`src/websocket/WebSocketClient.ts:178`:

```typescript
const url = `${this.options.sttSocket}/${this.options.sessionId}`;
this.socket = new WebSocket(url);
```

The WebSocket connection has **no authentication headers**. The browser WebSocket API does not support custom headers, but tokens can be passed as query parameters. Currently there is no mechanism to append `?token=…` or use a sub-protocol for auth negotiation. Any actor who discovers the session ID can connect to the same URL and receive audio transcriptions. `WebSocketClientOptions` has no `authToken` field.

**H-2: `WhisperWorkerEngine.worker.onerror` only rejects the _first_ pending request**
`src/engines/WhisperWorkerEngine.ts:148–154`:

```typescript
this.worker.onerror = (error) => {
  const pending = this.pendingRequests.values().next().value;
  if (pending) {
    pending.reject(new Error(`Worker error: ${error.message}`));
  }
};
```

If the worker crashes mid-session with multiple in-flight requests (which cannot happen today because `isTranscribing` serialises them, but will happen if concurrency is ever added), only the first pending request is rejected. The remaining Promises leak forever and `pendingRequests` grows unboundedly. Even with serialised usage, after a worker crash the `pendingRequests` Map is not cleared and the worker reference is not nulled, so subsequent transcribe calls will silently hang.

**H-3: Linear interpolation resampler causes aliasing artifacts on 44.1 kHz → 16 kHz**
`packages/room/src/utils/audioUtils.ts:137–156` — A linear interpolator has no anti-aliasing filter. When downsampling from 44.1 kHz or 48 kHz to 16 kHz, frequencies above 8 kHz (the Nyquist of the output) are **not removed before downsampling**. They alias back into the 0–8 kHz band. Speech energy above 8 kHz is modest but for fricatives (s, f, sh) and some medical terms the aliasing can corrupt the signal fed to Whisper. A correct implementation requires a low-pass filter (e.g., sinc FIR) before decimation, or use of the browser's `OfflineAudioContext` for quality resampling.

**H-4: `localProviderPool` is a static class-level singleton — leaks across test runs and concurrent instances**
`src/core/STTProcessor.ts:86`:

```typescript
private static localProviderPool = new Map<string, LocalSTTProvider>();
```

A static Map means all `STTProcessor` instances (across React component trees, multiple tabs via shared workers, or test runs without cleanup) share the same warm provider pool. If two different `useSTT` configurations are used concurrently (different model/language), `evictLocalProvidersExcept` will destroy one while the other is actively transcribing. In tests, the pool carries over between test cases unless `releaseWarmResources` is called.

**H-5: AudioBufferManager grows unboundedly during transcription stall**
`src/providers/LocalSTTProvider.ts:156–160`:

```typescript
this.bufferManager.append(audio, sampleRate);
if (this.bufferManager.hasChunk() && !this.isTranscribing) {
  await this.processBufferedAudio();
}
```

While `isTranscribing = true`, every `processAudio` call continues to `append()` without limit. If a transcription takes 10 s (slow WASM) and audio arrives at 44.1 kHz (4096-sample chunks every ≈93 ms via `ScriptProcessorNode`), the buffer accumulates ~10 s × 44100 × 4 bytes ≈ 1.7 MB of data per 10 s stall. Over a 10-minute session with a slow model this can exceed hundreds of MB.

**H-6: Reconnect backoff is linear, not exponential, and can trigger during intentional destroy**
`src/websocket/WebSocketClient.ts:361–370`:

```typescript
private scheduleReconnect(): void {
  this.reconnectAttempts++;
  setTimeout(() => {
    if (this.state !== 'connected') {
      this.connect().catch(() => {});
    }
  }, this.options.reconnectDelay * this.reconnectAttempts);
}
```

Linear backoff (1 s, 2 s, 3 s) hammers a briefly-down server. More critically, after `disconnect()` is called (which sets state to `'disconnected'`), a scheduled reconnect timer still fires, checks `state !== 'connected'` (true, since it's `'disconnected'`), and calls `connect()` again. There is no `destroyed` or `intentionalClose` flag to suppress post-disconnect reconnects.

---

### Medium

**M-1: Worker path is wrong at runtime if the worker file is not co-located with `index.mjs`**
`src/engines/WhisperWorkerEngine.ts:141`:

```typescript
this.worker = new Worker(new URL('./workers/whisper.worker.mjs', import.meta.url), { type: 'module' });
```

`import.meta.url` resolves to the URL of `dist/index.mjs` (or wherever the main bundle is loaded from). The worker file must be at `dist/workers/whisper.worker.mjs`. The `tsup.config.ts` correctly outputs it there (line 37), but if a bundler (Vite, webpack) re-bundles `@arcaai/stt` and the worker does not get emitted as a separate asset, the URL will 404 at runtime. There is no fallback beyond the main-thread WhisperEngine, but the silent fallback makes this hard to detect.

**M-2: `initial_prompt` (`TranscribeOptions.prompt`) is defined but never passed through the local path**
`src/engines/types.ts:80–82` defines `TranscribeOptions.prompt`. However:
- `WhisperEngine.transcribe` (line 142–154) never adds `initial_prompt` to `transcribeOptions`.
- The worker `transcribe()` function (line 273–285) likewise never passes `initial_prompt`.
- `LocalSTTProvider.transcribeSegment` (line 163–170) calls `this.engine.transcribe(audio)` with no options.

For the `prompt` field to work locally, `LocalProviderConfig` must gain a `prompt` field, `transcribeSegment` must receive it, and both engines must add `transcribeOptions.initial_prompt = options.prompt`.

**M-3: `WhisperWorkerEngine._progressHandler` stored via prototype cast — fragile**
`src/engines/WhisperWorkerEngine.ts:177–178` and `222–224`:

```typescript
(this as unknown as { _progressHandler: typeof progressHandler })._progressHandler = progressHandler;
```

This stores a callback on the instance through a TypeScript type cast workaround. If `reinitExistingWorker` is called while a previous init is in-progress, the second assignment overwrites `_progressHandler` and the first init's progress events are lost. The property is also never cleaned up.

**M-4: `BaseSTTProvider.onTranscription` and `onError` are single-slot — last-write wins**
`src/providers/BaseSTTProvider.ts:45–51`:

```typescript
onTranscription(callback: TranscriptionCallback): void {
  this.transcriptionCallback = callback;
}
```

The test `BaseSTTProvider.test.ts:193–203` explicitly asserts that calling `onTranscription` twice keeps only the second callback. This is intentional, but means consumers who want multiple subscribers (e.g., `STTProcessor` which wraps the provider _and_ also dispatches to its own EventEmitter) must be careful about ordering. If `bindLocalProviderCallbacks` is called before model-loaded event subscription, and a library consumer also calls `provider.onTranscription()`, the internal callback is overwritten.

**M-5: `handleClose` calls `scheduleReconnect` even if `disconnect()` was the trigger**
`src/websocket/WebSocketClient.ts:349–358`:

```typescript
private handleClose(code: number, reason: string): void {
  this.socket = null;
  this.callbacks.onClose?.(code, reason);
  if (code !== 1000 && this.reconnectAttempts < this.options.maxReconnectAttempts) {
    this.scheduleReconnect();
  } else {
    this.setState('disconnected');
  }
}
```

`disconnect()` (line 249) sends `stop`, then calls `socket.close(1000, 'Client disconnect')`, which triggers `onclose` with code 1000. Good — this path won't reconnect. But if the underlying WebSocket emits an `onerror` followed immediately by a `onclose` with code 1006 (abnormal close after the error fires), the reconnect fires even after explicit user disconnect if `disconnect()` was not called first. In practice, mobile network switches commonly produce 1006 closures.

**M-6: `destroy()` in `WhisperEngine` does not call `pipeline.dispose()` — GPU/WASM memory not freed**
`src/engines/WhisperEngine.ts:200–210`:

```typescript
async destroy(): Promise<void> {
  if (this.pipeline) {
    // Transformers.js pipelines are auto-cleaned by GC
    this.pipeline = null;
  }
  ...
}
```

The comment is incorrect. Transformers.js v3 pipelines that use WebGPU hold GPU buffer allocations and ONNX session objects that require explicit `dispose()` to release. Without it, repeated `init → destroy → init` cycles (e.g., from `reinitExistingWorker`) accumulate GPU memory until the tab crashes or runs out of VRAM. The worker's `destroyPipeline` (line 346–355) also simply nulls `whisperPipeline` without calling any cleanup API.

**M-7: `isWebGPUSupported()` is synchronous `'gpu' in navigator` — not a reliable check**
`src/utils/browserSupport.ts:52–58`:

```typescript
export function isWebGPUSupported(): boolean {
  return 'gpu' in navigator && navigator.gpu !== undefined;
}
```

This only checks that the API exists. A browser can expose `navigator.gpu` but have no suitable GPU adapter (e.g., VM, integrated GPU with no WebGPU driver). The synchronous check is used for `resolveDevice('auto')` in both `WhisperEngine` and `WhisperWorkerEngine`. This means the engine will attempt WebGPU initialization, fail at `pipeline()`, then fall back in the worker but **not** in `WhisperEngine` (the main-thread engine has no WASM fallback path in `resolveDevice`, it just silently returns `wasm` but the pipeline creation with `device: 'webgpu'` is already in flight). The async `isWebGPUAvailable()` exists but is never used in the hot path.

**M-8: AudioBufferManager chunk boundary overlap: overlapping audio is re-transcribed without deduplication**
`src/core/AudioBufferManager.ts:138–162` — The overlap mechanism retains `overlapSamples` (5 s by default) of audio at the start of each new chunk for context. Both chunks will contain identical transcription of that 5-second segment. There is no mechanism in `LocalSTTProvider` or `STTProcessor` to detect and deduplicate overlapping text. Users see repeated sentences for every 30-second boundary.

**M-9: `STTProcessor.setLanguage()` updates config but does not reinitialize**
`src/core/STTProcessor.ts:343–354`:

```typescript
async setLanguage(language: LanguageLocale): Promise<void> {
  this.options.audio.language = language;
  if (this.provider && this.resolvedProviderType === 'local') {
    console.warn('[STTProcessor] Language change requires reinitialization...');
  }
}
```

For local providers, the language change is silently ignored (with only a `console.warn`). The next transcription continues in the old language. The hook's `useSTT` exposes `setLanguage` and users can call it expecting the change to take effect immediately.

**M-10: `SpeakerVoiceFeatures.vector` in `TranscriptionResult` is a plain `number[]` sent to callers**
`src/types/index.ts:408–419` — The full MFCC+mel feature vector (~58 floats) is returned in every `TranscriptionResult` when diarization is enabled. This is serialized across the worker boundary and included in every `stt-transcription` event. Consumers who store transcripts (e.g., in a database) will accumulate large amounts of speaker feature data that may constitute biometric data under GDPR/HIPAA.

---

### Low

**L-1: `BaseEngine.getModelId` test uses `strideLengthS` instead of `overlapLengthS`**
`src/__tests__/BaseEngine.test.ts:108–115` — The `EngineConfig` shape in the test uses `strideLengthS` (a Transformers.js internal name) but the actual `EngineConfig` interface (`src/engines/types.ts`) uses `overlapLengthS`. The test config compiles because TypeScript is not strict about extra properties in object literals here, but the intent is misaligned.

**L-2: `RemoteSTTProvider.audioQueue` can accumulate indefinitely when WebSocket is `connecting`**
`src/providers/BackendSTTProvider.ts:237–239`:

```typescript
private flushAudioQueue(): void {
  if (this.audioQueue.length === 0 || !this.wsClient?.isConnected()) {
    return;
  }
```

During the `connecting` state (between `start()` and receipt of the `connected` server message), `processAudio` still enqueues but `flushAudioQueue` skips because `isConnected()` returns false. If connection takes several seconds, the queue holds several seconds of buffered audio without bound.

**L-3: `WhisperWorkerEngine` not exported from `src/index.ts`**
`src/index.ts:163–173` exports `WhisperEngine` but not `WhisperWorkerEngine`. Advanced consumers who want direct worker-based access must import from the internal path, which is fragile across builds.

**L-4: `BackendTestProvider` in tests uses `type = 'backend'` which is invalid in `STTProviderType`**
`src/__tests__/BaseSTTProvider.test.ts:461–462`:

```typescript
readonly type = 'backend' as const;
```

`STTProviderType` is `'local' | 'remote'`. This `'backend'` type is not in the union but compiles because the `as const` assertion bypasses the interface type check at this declaration site. The test at line 495 asserts `stats.providerType` equals `'backend'` — a value that can never be a valid `STTProviderType` in production code.

**L-5: `FFT` in `LocalSpeakerDiarizer` has an incorrect bit-reversal loop**
`src/providers/LocalSpeakerDiarizer.ts:308–314`:

```typescript
for (let b = 1; b < n; b <<= 1) {
  rev = (rev << 1) | (bits & 1);
  bits >>= 1;
}
```

The bit-reversal loop iterates `log2(n)` times (correct), but the condition `b < n` means it iterates `log2(n)` times only when `b` starts at 1 and doubles up to `n/2`. For `n = 2048` this is `b = 1, 2, 4, …, 1024` — 11 iterations — which is correct. However, the loop also places unreversed index `i` into `real[rev]`, not `real[i]`. The standard bit-reversal permutation should swap `real[i]` and `real[rev]` only when `rev > i`. As written, every input sample is placed at position `rev` without checking; if `rev < i`, the sample at `rev` is overwritten before it is read. This is a classic bit-reversal bug. In practice it means the FFT magnitudes are slightly wrong, degrading diarization accuracy but not causing crashes.

**L-6: `normalizeAudio` is exported but never used internally**
`src/utils/audioResampler.ts:217–245` — `normalizeAudio` is a public utility but is not called by `AudioBufferManager`, `LocalSTTProvider`, or any provider before submitting audio to Whisper. Without normalization, very quiet recordings (e.g., from far-field microphones) will produce empty or garbled transcripts.

**L-7: `vitest.setup.ts` missing from review but referenced by `vitest.config.ts`**
`packages/stt/vitest.config.ts` references `vitest.setup.ts`. This file exists but was not visible to review directly. Tests for `WhisperWorkerEngine` and `LocalSTTProvider` in integration are absent — all tests mock at the provider or engine interface level and do not exercise the actual Transformers.js pipeline path.

**L-8: `isTransformersJsSupported` uses `new Function('async () => {}')` — CSP violation**
`src/utils/browserSupport.ts:103–107`:

```typescript
// eslint-disable-next-line @typescript-eslint/no-implied-eval
new Function('async () => {}');
```

This uses the `Function` constructor which is blocked by any `Content-Security-Policy` that includes `'unsafe-eval'` restriction. A medical SaaS platform is likely to enforce strict CSP. The check will throw, `isTransformersJsSupported()` returns false, and the local provider is disabled even on capable browsers.

---

## 5. Security

**S-1: No WS auth token mechanism [High]**
As noted in H-1, audio streams are unauthenticated. The session ID in the URL is low-entropy (`stt-<base36 timestamp>-<8 random chars>`). The timestamp portion is predictable. An attacker on the same network can brute-force session IDs within a reasonable time window. Audio of medical consultations is PHI.

**S-2: Model source trust [Medium]**
The worker unconditionally loads from Hugging Face Hub:

```typescript
// whisper.worker.ts:116-118
env.useBrowserCache = true;
env.useCustomCache = false;
env.allowLocalModels = false;
```

There is no model integrity hash check (SRI equivalent). A compromised CDN or MITM could deliver a malicious ONNX model. The `assets/README.md` mentions custom model paths via `modelPath` but that path also has no integrity verification.

**S-3: `debugMode` logs full transcript JSON to `console.log` [Low]**
`src/core/STTProcessor.ts:628–654` — When `debugMode: true`, the full `DebugTranscriptEntry` with `words`, timestamps, and speaker IDs is logged to the browser console. In a medical context this constitutes PHI in browser logs, which may be captured by error-monitoring tools (Sentry, Datadog RUM) without consent.

**S-4: `SpeakerVoiceFeatures.vector` in event payloads = biometric data [Medium]**
See M-10. The 58-dimensional voice feature vector is derived from the speaker's vocal characteristics and constitutes biometric data under GDPR Art. 9 / HIPAA. It is included in every `stt-transcription` event when diarization is enabled, and a consumer storing transcriptions will store biometric data without a specific consent mechanism being enforced at the SDK level.

**S-5: WebSocket over `ws://` silently allowed [Low]**
`src/types/index.ts:795` and the README show `wss://` in examples, but the `sttSocket` field is just a `string` with no runtime validation that it starts with `wss://`. If a consumer passes `ws://`, audio PCM is transmitted in cleartext.

---

## 6. Performance

**P-1: No transferable in `postMessage` for audio [Critical → High]**
See C-2 above. Every transcription copies up to 1.92 MB (30 s × 16 kHz × 4 bytes). Fix: pass `{ transfer: [audio.buffer] }`.

**P-2: WebGPU fp16 dtype selection improves GPU perf but fp16 is unsupported on some adapters [Medium]**
`src/engines/WhisperEngine.ts:81`:

```typescript
const dtype = this.actualDevice === 'webgpu' ? { encoder_model: 'fp16' as const, decoder_model_merged: 'fp16' as const } : undefined;
```

FP16 is significantly faster on discrete GPUs. However, on Apple Silicon M1/M2 and some integrated GPUs, fp16 WebGPU support has compatibility issues with older Transformers.js ONNX models. A fallback to `{ encoder_model: 'q4' as const, … }` for faster WASM paths or `fp32` for WebGPU compatibility would be more robust.

**P-3: No SharedArrayBuffer / multi-threaded WASM [Medium]**
`whisper.worker.ts:135–136` hardcodes `numThreads = 1` with a comment about `SharedArrayBuffer`. For WASM inference, ONNX Runtime Web can use multi-threaded WASM when SAB is available, providing 2–4× speedup on large models. If the app serves with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`, SAB is available and `numThreads` could be set to `navigator.hardwareConcurrency`. The package checks `sharedArrayBuffer` in `getSTTBrowserSupport()` but never uses it.

**P-4: `AudioBufferManager.getChunk()` always `concatenateFloat32Arrays` before slicing [Low]**
`src/core/AudioBufferManager.ts:144–162` — On every `getChunk()` call, all buffer segments are concatenated into a single `Float32Array` before slicing. After 30 s at 44.1 kHz (resampled), this is a 480 000-element array. A ring buffer or typed-array segment splicing would avoid the O(n) allocation. For short sessions this is negligible; for continuous long-running sessions it creates GC pressure.

**P-5: Cold-start latency not quantified in stats [Low]**
`EngineStats.modelLoadTimeMs` is tracked but the progress callback reports `progress: 0` at start and `progress: 1` after each file, without a total progress indicator. The `ModelLoadProgress.loaded` / `total` bytes are per-file, making it impossible for the UI to show overall download progress for multi-file models (encoder + decoder + tokenizer).

**P-6: 500ms polling interval in `LocalSTTProvider` [Low]**
`src/providers/LocalSTTProvider.ts:131–133`:

```typescript
this.processingInterval = setInterval(() => {
  this.processBufferedAudio();
}, 500);
```

With a 30 s chunk size, this polling adds up to 500 ms of extra latency per transcription (chunks that arrived just after a poll are not processed until the next one). The in-`processAudio` check on line 158 triggers immediately on chunk completion but only if `!isTranscribing`, so for the common case where the previous transcription is still in flight, the 500 ms timer governs. Using a `Promise`-chained loop or `queueMicrotask` after each transcription completes would be more responsive.

**P-7: Model IDs only cover `onnx-community` and `Xenova` prefixes [Medium]**
`src/engines/BaseEngine.ts:67–75`:

```typescript
const prefix = quantized ? 'onnx-community' : 'Xenova';
return `${prefix}/whisper-${model}${modelSuffix}${timestampSuffix}`;
```

As of 2026, Transformers.js v3 fully supports `openai/whisper-large-v3-turbo` and `distil-whisper/distil-large-v3` ONNX models from the official HF hub with significantly better WER. The hardcoded `onnx-community` / `Xenova` prefixes mean users must specify the full HF model ID manually — the README's model table shows only these older paths. Whisper large-v3-turbo is ~809 MB but 2× faster inference and better WER than large-v2.

---

## 7. Test Coverage Gaps

| Area | Current State | Gap |
|---|---|---|
| `WhisperEngine` integration | No integration tests; only unit via `TestEngine` | No real Transformers.js pipeline test |
| `WhisperWorkerEngine` | Not directly tested | Worker spawning, init, transcribe, destroy all untested |
| `LocalSTTProvider` | Not tested | Buffer accumulation, flush-on-stop, diarization integration |
| `RemoteSTTProvider` | Not tested | Audio queue drain, reconnect, stop behavior |
| `STTProcessor` | Not tested | Provider pool logic, `setupAudioCapture`, `ScriptProcessorNode`, event routing |
| `useSTT` hook | Only interface shape tested (no `renderHook`) | Auto-attach, detach, error state, configFingerprint change |
| `LocalSpeakerDiarizer` FFT correctness | Functional tests only | No test verifying FFT magnitude accuracy vs reference |
| Resampler 44.1 kHz path | `prepareFloat32ForWhisper(samples, 44100)` tested for length only | No SNR / frequency-accuracy test |
| WebGPU fallback | Not tested | `resolveDevice('webgpu')` when `isWebGPUSupported()` returns false |
| Worker path resolution | Not tested | Worker URL not found = silent main-thread fallback |
| `prompt` option forwarding | Not tested | No test verifying `initial_prompt` reaches Transformers.js |
| Auth token | Not tested | No test verifying `sttSocket` rejects `ws://` |
| Long-session OOM | Not tested | No test for buffer size under stalled transcription |

---

## 8. Conformance: Transformers.js v3, ONNX, and Whisper 2026

**8.1 Transformers.js version**
Pinned to `@huggingface/transformers@3.8.1`. The latest stable release as of May 2026 is `3.x` (3.8+ branch is current). The API used (`pipeline('automatic-speech-recognition', …)`) is stable. However, the `progress_callback` format changed in v3 compared to v2 — the current code checks for `progressData.status === 'progress'` and `progressData.progress !== undefined`, which is correct for v3. This is fine.

**8.2 ONNX Runtime Web version**
Pinned to `1.22.0-dev.20250409-89f8206ba4` — **this is a pre-release development build**. This is the correct pin used by Transformers.js 3.8.x (ORT Web is bundled by Transformers.js). However, installing `onnxruntime-web` as a direct peer dependency at this dev version is fragile: the version string is git-hash-based and will never be published to a stable release channel. If the HF CDN removes this build, `npm install` will break. The correct approach is to remove `onnxruntime-web` from direct dependencies and let Transformers.js manage it internally.

**8.3 Whisper model coverage**
The package only officially supports `onnx-community/whisper-{tiny,base,small,medium,large}(.en)` and `Xenova/whisper-{tiny,base,small}`. The following current best-practice models are not documented:
- `openai/whisper-large-v3-turbo` — best accuracy/speed ratio as of 2025-2026
- `distil-whisper/distil-large-v3` — 6× faster than large-v3, WER within 1%
- `onnx-community/whisper-large-v3-turbo` — quantized ONNX-community build
- Any faster-whisper ONNX CTranslate2 export (incompatible format; different exporter needed)

**8.4 Chunk boundary hallucination**
Whisper is known to hallucinate at chunk boundaries when no context is provided. The 5-second overlap helps but is insufficient without `condition_on_previous_text=True` and passing the previous chunk's decoded text as `initial_prompt`. This is not implemented for either engine path. The research community (Karpathy et al., "whisper_streaming" 2023; Chen et al. 2024) recommends using a sliding window with previous-chunk conditioning to suppress boundary hallucinations.

**8.5 Word-level timestamps — `_timestamped` model selection is correct**
`BaseEngine.getModelId()` correctly selects `whisper-{size}_timestamped` for `returnTimestamps === 'word'` and falls back to chunk-level in the cross-attention error handler. This is the correct pattern for Transformers.js v3 DTW-based word timestamps.

---

## 9. Refactor / Improvement Suggestions

### 9.1 Fix audio transferable immediately

```typescript
// WhisperWorkerEngine.ts — sendWorkerRequest for 'transcribe'
this.worker.postMessage(
  { type, id: requestId, payload },
  payload && (payload as { audio?: Float32Array }).audio?.buffer
    ? [(payload as { audio: Float32Array }).audio.buffer]
    : []
);
```

### 9.2 Replace ScriptProcessorNode with AudioWorkletNode

Create `src/worklets/stt-capture.worklet.ts`:

```typescript
class STTCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel) this.port.postMessage(channel, [channel.buffer]);
    return true;
  }
}
registerProcessor('stt-capture', STTCaptureProcessor);
```

### 9.3 Wire `initial_prompt` through the local path

```typescript
// LocalProviderConfig — add:
prompt?: string;

// LocalSTTProvider.transcribeSegment:
const result = await this.engine.transcribe(audio, {
  prompt: (this.config as LocalProviderConfig).prompt,
});

// WhisperEngine.transcribe — add to transcribeOptions:
if (options?.prompt) transcribeOptions.initial_prompt = options.prompt;
```

### 9.4 Replace linear backoff with exponential + jitter

```typescript
private scheduleReconnect(): void {
  if (this.isDestroyed) return;
  this.reconnectAttempts++;
  const baseDelay = this.options.reconnectDelay;
  const expDelay = baseDelay * Math.pow(2, this.reconnectAttempts - 1);
  const jitter = Math.random() * 0.3 * expDelay;
  const delay = Math.min(expDelay + jitter, 30000);
  this._reconnectTimer = setTimeout(() => { ... }, delay);
}
```

### 9.5 Add `initial_prompt` conditioning from previous chunk

In `LocalSTTProvider.processBufferedAudio`, keep a `lastTranscriptText` ref and pass it as `initial_prompt` to the engine for the next chunk. This directly suppresses boundary hallucination.

### 9.6 Streaming via `stt` service

The `apps/stt/` Python FastAPI service likely implements streaming Whisper inference (e.g., via faster-whisper's streaming generator). To integrate:

1. **Protocol extension:** Add a `stream_partial` message type to `WSInboundMessage` alongside the existing `transcription`.
2. **MessageHandler extension:** Route `stream_partial` to an `onPartial` callback.
3. **`RemoteSTTProvider` extension:** Add `onPartialTranscription` callback and emit `stt-partial` events.
4. **`STTProcessor` extension:** The `handleTranscription` method already handles `isFinal: false` → `stt-partial`; this path already exists end-to-end.
5. **VAD-gated streaming:** The `vadGate` feature flag already exists. When enabled, `ScriptProcessorNode` events are suppressed and `transcribeSegment()` is called externally. The `stt` service could accept VAD-segmented audio chunks and return streaming word-by-word results.

### 9.7 Add WebSocket auth token support

```typescript
// WebSocketClientOptions — add:
authToken?: string;

// connect() — build URL:
const params = this.options.authToken
  ? `?token=${encodeURIComponent(this.options.authToken)}`
  : '';
const url = `${this.options.sttSocket}/${this.options.sessionId}${params}`;
```

### 9.8 Replace `localProviderPool` static with instance-level registry

Move `localProviderPool` to a React Context (in `useSTT`) or a module-level singleton that can be explicitly cleared, to prevent cross-test and cross-instance contamination.

### 9.9 Add better models to documentation

Add `openai/whisper-large-v3-turbo` and `distil-whisper/distil-large-v3` to the model table in `README.md` and `assets/README.md`, with recommended use cases (the former for maximum accuracy in medical settings, the latter for real-time with minimal accuracy loss).

### 9.10 Fix FFT bit-reversal in `LocalSpeakerDiarizer`

The standard Cooley-Tukey radix-2 DIT FFT requires in-place bit-reversal permutation (swap `real[i]` and `real[rev]` when `rev > i`). The current implementation overwrites indices without checking:

```typescript
// Current (incorrect):
real[rev] = frame[i]!;

// Correct (build permuted copy first, then FFT in-place):
const permuted = new Float32Array(n);
for (let i = 0; i < n; i++) {
  // ... compute rev ...
  permuted[rev] = frame[i]!;
}
permuted.forEach((v, i) => (real[i] = v));
```

---