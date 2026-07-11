> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `explorer` `a91b73a5c8da32679` (sub-agent of 11). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# `packages/stt` Research Findings — Local Whisper Path & WebSocket Client

Scope: `packages/stt/src/**` only. All citations exclude `.claude/worktrees/` and `node_modules`. Line numbers are from the exact files read.

---

## 0. Dependencies (`packages/stt/package.json`)

```
"dependencies": {
  "@huggingface/transformers": "4.2.0",
  "eventemitter3": "^5.0.4",
  "onnxruntime-common": "1.27.0",
  "onnxruntime-web": "1.27.0"
}
```
(`packages/stt/package.json:56-59`). No `@xenova/transformers` — the library used is **`@huggingface/transformers` v4.2.0** (the successor package), pinned exactly, backed by `onnxruntime-web`/`onnxruntime-common` **1.27.0** (both exact-pinned, no `^`).

---

## 1. Local Whisper path — model ID, quantization, WebWorker protocol

**Model ID construction** — `BaseEngine.getModelId()` (`packages/stt/src/engines/BaseEngine.ts:67-75`), shared by both `WhisperEngine` and `WhisperWorkerEngine`:

```ts
protected getModelId(model: string, language: string, quantized: boolean, returnTimestamps?: boolean | 'word'): string {
  const needsTimestampedModel = returnTimestamps === 'word';
  const isEnglish = language === 'en' || language.startsWith('en-');
  const modelSuffix = isEnglish && !needsTimestampedModel ? '.en' : '';
  const prefix = quantized ? 'onnx-community' : 'Xenova';
  const timestampSuffix = needsTimestampedModel ? '_timestamped' : '';
  return `${prefix}/whisper-${model}${modelSuffix}${timestampSuffix}`;
}
```
Verbatim template: **`` `${prefix}/whisper-${model}${modelSuffix}${timestampSuffix}` ``** (`BaseEngine.ts:74`). Example resolved IDs for `model='tiny'`, `language='en-US'`:
- quantized (default), chunk timestamps → **`onnx-community/whisper-tiny.en`**
- quantized, `returnTimestamps: 'word'` → **`onnx-community/whisper-tiny_timestamped`** (multilingual export required for cross-attention DTW — `.en` suffix dropped, `BaseEngine.ts:59-65` doc comment)
- `quantized: false` → **`Xenova/whisper-tiny.en`**

Local-provider size resolution/fallback (`packages/stt/src/types/index.ts`):
- `BROWSER_LOADABLE_WHISPER_SIZES: readonly WhisperModelSize[] = ['tiny', 'base', 'small']` (`types/index.ts:991`) — `medium`/`large` are explicitly excluded because `onnx-community/whisper-large-v3` is gated and 401s (`types/index.ts:986-990`).
- `DEFAULT_LOCAL_WHISPER_SIZE: WhisperModelSize = 'base'` (`types/index.ts:997`) — fallback when a configured `modelId` isn't browser-loadable, via `resolveLocalWhisperModel()` (`types/index.ts:1015-1042`), called from `LocalSTTProvider.init()` (`LocalSTTProvider.ts:89`).

**"Quantization" is NOT a `dtype`/`quantized` pipeline parameter** — `quantized` only selects the **HF repo prefix** (`onnx-community` vs `Xenova`) inside `getModelId`; it is never forwarded to `pipeline()`. Confirmed by grep — `quantized` appears only in `BaseEngine.ts:67,71`, `engines/types.ts:31` (the `EngineConfig.quantized: boolean` field), and doc comments. Notably it is **not even present in the worker's `InitPayload`** (`whisper.worker.ts:23-31`) — because `modelId` is resolved on the main thread *before* being posted to the worker, `quantized` is already "baked into" the ID string by the time it crosses the worker boundary.

**dtype** (verbatim, identical logic duplicated in both the main-thread engine and the worker):
- `WhisperEngine.ts:79-81`: `const dtype = this.actualDevice === 'webgpu' ? { encoder_model: 'fp16' as const, decoder_model_merged: 'fp16' as const } : undefined;` (comment: "fp16 for WebGPU (faster, less VRAM), fp32 for WASM (no fp16 support)").
- `whisper.worker.ts:205-214` (`buildPipelineOptions`): same `{ encoder_model: 'fp16', decoder_model_merged: 'fp16' }` for webgpu, `undefined` for wasm.

**Library that loads it**: dynamic `import('@huggingface/transformers')` — `WhisperEngine.ts:77` and `whisper.worker.ts:152` (`const { pipeline, env } = await import('@huggingface/transformers');`), then `pipeline('automatic-speech-recognition', modelId, {...})`.

**Runs inside a WebWorker — confirmed.** `WhisperWorkerEngine.initWithWorker()`:
```ts
this.worker = new Worker(new URL('./workers/whisper.worker.mjs', import.meta.url), { type: 'module' });
```
(`WhisperWorkerEngine.ts:176`; comment notes the path is relative to `dist/index.mjs` post-tsup-build). `WhisperWorkerEngine.isSupported()`/`usesWorker()` gate on `typeof Worker !== 'undefined'` (`WhisperWorkerEngine.ts:44-46, 128-138`); if unavailable it falls back to instantiating `WhisperEngine` on the main thread (`initMainThread`, `WhisperWorkerEngine.ts:275-284`).

**postMessage protocol** (`whisper.worker.ts:7-10` doc comment + `:12-60` types):
- Main → Worker: `{ type: 'init' | 'transcribe' | 'destroy' | 'check-cache', id: string, payload }` (`WorkerMessage`, `whisper.worker.ts:12-17`; mirrored as `WorkerRequest` in `WhisperWorkerEngine.ts:21-25`).
- Worker → Main: `{ type: 'ready' | 'progress' | 'result' | 'error', id: string, payload: unknown }` (`WorkerResponse`, `whisper.worker.ts:56-60`, `WhisperWorkerEngine.ts:27-31`).
- Init payload fields: `{ modelId, device: 'webgpu'|'wasm'|undefined, language, codeSwitching?, chunkLengthS, overlapLengthS, returnTimestamps }` (`whisper.worker.ts:23-31`; posted from `WhisperWorkerEngine.ts:211-223`).

**Transferable usage (zero-copy)** — `WhisperWorkerEngine.transcribe()`:
```ts
const result = await this.sendWorkerRequest<TranscriptionResult>('transcribe', { audio, options: {...} }, [audio.buffer]);
```
(`WhisperWorkerEngine.ts:373-387`), and `sendWorkerRequest` calls `this.worker.postMessage({ type, id, payload } as WorkerRequest, transfer)` (`WhisperWorkerEngine.ts:422-429`). Comment: "avoids the ~1.9 MB structured-clone per 30 s chunk that would otherwise occur on every transcription (TASK-270 / C-2)" (`WhisperWorkerEngine.ts:369-372`) — the caller's `audio` view is **detached** after the call. Confirmed by `packages/stt/src/__tests__/worker-transferable.test.ts:74-89`: `expect(transferList).toContain(expectedBuffer)`. The worker's result payload (text/timestamps only) is NOT transferred back — no large buffer round-trips.

---

## 2. WhisperEngine vs WhisperWorkerEngine vs BaseEngine

`BaseEngine` (`packages/stt/src/engines/BaseEngine.ts:14-76`) is an **abstract class** implementing the `STTEngine` interface (`engines/types.ts:150-189`):
- abstract: `readonly name`, `isSupported()`, `init(config: EngineConfig)`, `transcribe(audio, options?)`, `destroy()`
- concrete: `isReady()`, `getStats()`, `protected recordTranscription(latencyMs)`, `protected getModelId(...)` (shared model-id logic above).

- **`WhisperEngine`** (`engines/WhisperEngine.ts:44`, `readonly name = 'whisper-transformers'`) extends `BaseEngine` and runs the `@huggingface/transformers` pipeline **directly on the main thread**.
- **`WhisperWorkerEngine`** (`engines/WhisperWorkerEngine.ts:103`, `readonly name = 'whisper-worker'`) extends `BaseEngine`, spawns the Worker above, and proxies every call via postMessage. If `Worker` is unsupported it internally constructs a `WhisperEngine` (dynamic `import('./WhisperEngine.js')`, `WhisperWorkerEngine.ts:275-284`) and delegates `transcribe()` to it (`WhisperWorkerEngine.ts:340-344`).

**Which one `LocalSTTProvider` actually instantiates**:
```ts
// LocalSTTProvider.ts:93-95
const workerEngine = new WhisperWorkerEngine();
this.engine = workerEngine;
this.usesWorker = workerEngine.usesWorker();
```
`LocalSTTProvider` **always** constructs `WhisperWorkerEngine` — `WhisperEngine` is only reachable indirectly as `WhisperWorkerEngine`'s internal no-Worker fallback, never directly instantiated by any provider.

**Public API-surface gap** (worth flagging for the review): the top-level package barrel `packages/stt/src/index.ts:174-186` re-exports only `BaseEngine` and `WhisperEngine` from `./engines/index.js` — it does **not** re-export `WhisperWorkerEngine` or `STTWorkerCrashError` (`engines/errors.ts:27-38`), even though `engines/index.ts:15-27` exports both internally and `package.json`'s `exports` map has only a single `"."` subpath (no `./engines` subpath). So a consumer importing from `@arcaai/stt` cannot `instanceof STTWorkerCrashError`-check the error that the actually-used engine (`WhisperWorkerEngine`) throws on worker crash — only `.name === 'STTWorkerCrashError'`/`.message` string-matching is available outside `packages/stt/src`.

Crash-recovery config on `WhisperWorkerEngine` (`WhisperWorkerEngineOptions`, `WhisperWorkerEngine.ts:85-101`, constructor `:121-126`): `maxCrashRetries` default **`3`**, `crashBackoffBaseMs` default **`100`** (ms). See §7 for the backoff formula.

---

## 3. StreamingBackendSTTProvider vs BackendSTTProvider(`RemoteSTTProvider`) — and `BaseSTTProvider` contract

Correction to the "streaming/WS vs batch/HTTP" framing: **both providers are WebSocket-streaming providers** — there is no batch/HTTP request-response provider in this file set. `RemoteSTTProvider.transcribeSegment()` explicitly throws and tells the caller to use a separate REST API for file transcription (`packages/stt/src/providers/BackendSTTProvider.ts:179-187`) — that REST API is not part of this package. The real distinction is **legacy custom WS protocol vs the newer pipeline-aware STT-V2 WS protocol**:

**`BaseSTTProvider`** (`providers/BaseSTTProvider.ts:14-90`) — abstract class implementing `STTProvider` (`providers/types.ts:22-101`). Abstract contract: `readonly name`, `readonly type: 'local'|'remote'`, `isSupported()`, `init(config)`, `start()`, `stop()`, `processAudio(audio, sampleRate)`, `transcribeSegment(audio)`, `destroy()`. Concrete helpers: `isReady()`, `isProcessing()`, `onTranscription(cb)`, `onError(cb)`, `getStats()`, `protected emitTranscription/emitError/recordTranscription`.

**`RemoteSTTProvider`** — file is `providers/BackendSTTProvider.ts`, class name is `RemoteSTTProvider` (naming mismatch between filename and class), also exported as legacy alias `BackendSTTProvider` (`providers/index.ts:15,27`). `@deprecated TASK-298 D-4` (`BackendSTTProvider.ts:18-22`): "Prefer StreamingBackendSTTProvider... This legacy provider remains for backward compatibility with callers that pass an `sttSocket` URL only; it will be removed in a future cleanup ticket." It owns its own `WebSocketClient` + `MessageHandler` (`BackendSTTProvider.ts:60-124`), client-side buffers audio into `audioQueue: Float32Array[]` and flushes on a `setInterval(..., SEND_INTERVAL_MS)` (100ms, `BackendSTTProvider.ts:67, 140-142`) only once `MIN_SAMPLES_TO_SEND` (1600 samples, `BackendSTTProvider.ts:68`) is queued (`flushAudioQueue`, `BackendSTTProvider.ts:243-269`).

**`StreamingBackendSTTProvider`** (`providers/StreamingBackendSTTProvider.ts:133`) — TASK-298 D-4 replacement. It owns **no WebSocket class of its own**; it requires two externally-constructed, duck-typed dependencies injected via its constructor (`StreamingBackendSTTProvider.ts:154-167`):
- `StreamingSessionLike` (`:103-126`) — `createSession(...)`, `getWebSocketUrl(token?)`, `closeSession()`, `refreshTicket?()`, `getSessionId()`. Concrete impl: `StreamingSessionManager` in `@arcaai/vox`.
- `StreamingWsClientLike` (`:76-98`) — `connect(url)`, `isConnected()`, `sendAudioFrame(data): boolean` (backpressure-aware — returns `false` on drop), `sendStop()`, `disconnect()`, `onTranscript(cb)`, `onWsError(cb)`. Concrete impl: `SttV2WebSocketClient` in `@arcaai/vox` (covered by the other researcher; duck-typed on purpose to avoid a reverse package dependency — `:16-23`).

Requires `pipelineId` (mandatory, throws `'pipelineId is required for StreamingBackendSTTProvider'` if missing at `init()` — `:175-177`). `processAudio()` converts float32→int16 via `float32ToInt16` and calls `wsClient.sendAudioFrame(int16)` **per call, no client-side interval throttle** (unlike the legacy provider) — `:225-243`. Honors backpressure: if `sendAudioFrame` returns `false`, increments `droppedFrameCount` and fires a push callback `onDropCallback` (TASK-464) so drops surface to the store/UI instead of dead-ending in a polled getter (`:236-242, 281-299`). `transcribeSegment()` also throws not-supported (`:246-248`).

**Selection logic lives in `STTProcessor`, not in either provider file** (`packages/stt/src/core/STTProcessor.ts:666-676`):
```ts
private async initializeRemoteProvider(): Promise<void> {
  if (this.streamingTransport) {
    await this.initializeStreamingRemoteProvider(this.streamingTransport);
    return;
  }
  const provider = new RemoteSTTProvider();   // legacy fallback
  ...
```
`this.streamingTransport` is set via `setStreamingTransport()` (`STTProcessor.ts:338-340`), which is called by SDK glue code (`PluginManager.buildStreamingTransport`, in `@arcaai/vox`) only when a `pipelineId` is configured **and** `provider !== 'local'` **and** an `apiClient` exists (verified: `packages/agentic-sdk-v2/src/core/PluginManager.ts:743-772`). When that condition isn't met, `STTProcessor` falls back to legacy `RemoteSTTProvider` — i.e. `WebSocketClient.ts` is effectively a dead/legacy path in the production streaming flow (see §WebSocketClient-wiring below).

---

## 4. `AudioBufferManager.ts` — buffering/chunking

`DEFAULT_BUFFER_OPTIONS` (`AudioBufferManager.ts:43-48`):
```ts
export const DEFAULT_BUFFER_OPTIONS: Required<AudioBufferManagerOptions> = {
  sampleRate: WHISPER_SAMPLE_RATE, // 16000
  chunkLengthS: 30,
  overlapLengthS: 5,
  minBufferS: 1,
};
```
Sample-count derivation (`AudioBufferManager.ts:91-93`): `chunkSamples = Math.floor(chunkLengthS * sampleRate)` → **480000** samples at defaults; `overlapSamples = Math.floor(overlapLengthS * sampleRate)` → **80000**; `minBufferSamples = Math.floor(minBufferS * sampleRate)` → **16000**.

Structure: **growing array of chunks, not a ring buffer** — `private buffer: Float32Array[] = []` (`:77`), appended via `.push()` in `append()` (`:102-109`), and concatenated on demand via `concatenateFloat32Arrays` (`audioResampler.ts:492-511`) inside `getChunk()`/`flush()`/`peek()`.

`getChunk()` (`:138-162`): slices off exactly `chunkSamples`, then retains a tail of `overlapSamples` (5s) as the seed of the next buffer — classic sliding-window chunking:
```ts
const remainingSamples = this.totalSamples - this.chunkSamples + this.overlapSamples;
if (remainingSamples > 0) {
  const startIndex = this.chunkSamples - this.overlapSamples;
  const remaining = fullBuffer.slice(startIndex);
  this.buffer = [remaining];
  this.totalSamples = remaining.length;
} else { this.buffer = []; this.totalSamples = 0; }
```
**No overflow/backpressure handling inside `AudioBufferManager` itself** — `append()` unconditionally grows the buffer; nothing caps it or drops samples. Backpressure is enforced elsewhere: `LocalSTTProvider.start()` polls every **500ms** (`setInterval(() => this.processBufferedAudio(), 500)`, `LocalSTTProvider.ts:138-140`) and drains `while (bufferManager.hasChunk())` guarded by an `isTranscribing` flag so only one transcription runs at a time (`LocalSTTProvider.ts:228-249`) — if inference is slower than capture, the buffer array simply keeps growing unboundedly until the next drain.

---

## 5. `audioCapture.ts` + `stt-capture.worklet.ts` — capture path and its relationship to `@arcaai/room`

**Not a redundant/parallel capture path** — it taps the **same** `MediaStreamTrack` + shared `AudioContext` that `@arcaai/room` hands to every processor. Import graph: `STTProcessor extends BaseProcessor` from `@arcaai/room` (`STTProcessor.ts:8-15,102`); `BaseProcessor.onInit(opts: AudioProcessorOptions)` is the room-defined lifecycle hook (`packages/room/src/processors/BaseProcessor.ts:194`); `AudioProcessorOptions extends ProcessorOptions { track: MediaStreamTrack; audioContext: AudioContext; element?; kind:'audio' }` (`packages/room/src/processors/types.ts:18-33`). `STTProcessor.onInit()` destructures `{ audioContext, track }` (`STTProcessor.ts:172`) and calls `setupAudioCapture(audioContext, track)` (`:207`), which calls `createAudioCapture(audioContext, track, onFrame)` from `./audioCapture.js` (imported at `STTProcessor.ts:46`).

However, it **is** an architecturally separate Web-Audio-graph tap (its own `MediaStreamAudioSourceNode` + own `AudioWorkletNode`) rather than one processor forwarding decoded frames to the next in JS — `stt-capture.worklet.ts`'s own docstring says this "matches the pattern already used by `@arcaai/vad` and `@arcaai/noise-filter`" (`stt-capture.worklet.ts:21-24`), i.e. every processor in a room pipeline independently taps the shared track. `createAudioCapture()` (`audioCapture.ts:88-111`) builds `new MediaStreamAudioSourceNode` from `new MediaStream([track])` (`:94-95`), preferring `AudioWorkletNode` (`isAudioWorkletUsable`, `:70-76`) and falling back to a deprecated `ScriptProcessorNode` with buffer size **`SCRIPT_PROCESSOR_BUFFER_SIZE = 4096`** samples (`:21, 176`; "≈85 ms at 48 kHz" per file docstring `:12`) plus a one-time `console.warn` (`:101-108`).

**Worklet frame coalescing** (`stt-capture.worklet.ts`) — `STT_CAPTURE_PROCESSOR_NAME = 'stt-capture-worklet-processor'` (`:31`), registered via `@arcaai/room`'s `createWorkletLoader` (blob-URL + registration caching, `:26,130-133`). `DEFAULT_STT_CAPTURE_FRAME_MS = 80` (`:36`). Inside the inline worklet source (`:52-128`), 128-sample render quanta are accumulated into a preallocated buffer sized `this.targetSamples = Math.max(128, Math.round((sampleRate * frameMs) / 1000))` (`:67`) and posted as ONE `Transferable` frame (`this.port.postMessage(frame, [frame.buffer])`, `:94,119`) once full — docstring claims this cuts message rate from ~375/s (raw 128-sample quanta @ 48kHz) to **~12/s** at the 80ms default (`:8-13`). Backpressure/pause support: main thread posts `{type:'setEnabled', enabled:false}` (flushes remainder first) or `{type:'flush'}` to force out a partial frame before stop (`:15-19, 76-85`).

The capture graph's output is silenced via a **zero-gain sink** (`sink.gain.value = 0`, `audioCapture.ts:131-132,177-178`) connected to `audioContext.destination` — required only so Web Audio keeps pulling render quanta, not for playback.

**Perf-review note**: `STTProcessor.onInit()` builds **two separate `MediaStreamAudioSourceNode`s** from the same track on every attach cycle — one inside `createAudioCapture` (`audioCapture.ts:95`) feeding the STT worklet, and a second, independent one directly in `onInit` for pass-through (`const source = audioContext.createMediaStreamSource(stream); ... this.processedTrack = destination.stream.getAudioTracks()[0];`, `STTProcessor.ts:215-219`) that produces `processedTrack` for any downstream processor in the pipeline. Two source nodes per attach, not a shared one.

---

## 6. `audioResampler.ts` — target rate & algorithm

`WHISPER_SAMPLE_RATE = 16000` (`audioResampler.ts:17`) — the definitive target, used by `AudioBufferManager` defaults, both remote providers' `processAudio`, and `STTOptions.audio.sampleRate` default (`types/index.ts:124`, `DEFAULT_AUDIO_CONFIG.sampleRate: 16000`).

**Source rate is not hardcoded** — it's whatever `AudioContext.sampleRate` the browser is running (commonly 48000Hz), passed straight through: `this.provider.processAudio(frame, audioContext.sampleRate)` (`STTProcessor.ts:777`).

**Algorithm** (TASK-351 P2-4): **anti-aliased Kaiser-windowed-sinc polyphase resampler**, `resampleSinc()` (`audioResampler.ts:230-248`), used by the hot-path helpers `prepareFloat32ForWhisper()` (`:349-356`, called whenever `sampleRate !== WHISPER_SAMPLE_RATE`, itself called from `AudioBufferManager.append` and both remote providers) and `prepareAudioForWhisper()` (AudioBuffer variant, `:318-340`). Verbatim constants:
```ts
const SINC_TAPS_PER_BRANCH = 32;   // :30 — taps per polyphase branch
const KAISER_BETA = 9;             // :33 — β=9 → "≈90 dB design stopband attenuation"
const SINC_CUTOFF_RATIO = 0.45;    // :36 — cutoff ≈0.45× the smaller rate (≈7.2 kHz for a 16 kHz target)
const MAX_POLYPHASE_BRANCHES = 1024; // :39 — above this, falls back to resampleSincDirect
const SINC_BANK_CACHE_LIMIT = 8;   // :42 — cached filter banks keyed by `${fromRate}->${toRate}`
```
A **legacy linear-interpolation resampler**, `resampleLinear()` (`:259-261`), delegates to `@arcaai/room`'s `resampleAudio` and is explicitly kept only "for backward compatibility" (file header, `:6-10`) — it is **not** used by the hot capture path (both `prepareFloat32ForWhisper`/`prepareAudioForWhisper` call `resampleSinc`, never `resampleLinear`). Int16 PCM helpers used for the wire protocol: `float32ToInt16()` (`:378-385`, clamp `Math.max(-1, Math.min(1, x))`, scale ×32768 negative / ×32767 positive) and `int16ToFloat32()` (`:364-370`, divide by 32768.0).

---

## 7. Numeric constants (chunking, timeouts, backoff)

| Constant | Value | File:line |
|---|---|---|
| `AudioBufferManager` chunk length | `30` s (→ 480000 samples @16kHz) | `AudioBufferManager.ts:45` |
| `AudioBufferManager` overlap length | `5` s (→ 80000 samples) | `AudioBufferManager.ts:46` |
| `AudioBufferManager` min buffer | `1` s (→ 16000 samples) | `AudioBufferManager.ts:47` |
| STT capture worklet coalesced frame | `DEFAULT_STT_CAPTURE_FRAME_MS = 80` ms | `stt-capture.worklet.ts:36` |
| `ScriptProcessorNode` fallback buffer | `SCRIPT_PROCESSOR_BUFFER_SIZE = 4096` samples | `audioCapture.ts:21` |
| `LocalSTTProvider` drain poll interval | `setInterval(..., 500)` — 500 ms | `LocalSTTProvider.ts:138-140` |
| Legacy `RemoteSTTProvider` send interval | `SEND_INTERVAL_MS = 100` ms | `BackendSTTProvider.ts:67` |
| Legacy `RemoteSTTProvider` min samples to send | `MIN_SAMPLES_TO_SEND = 1600` ("~100ms at 16kHz") | `BackendSTTProvider.ts:68` |
| `WhisperWorkerEngine` max crash retries | default `3` | `WhisperWorkerEngine.ts:92` (`maxCrashRetries ?? 3` at `:124`) |
| `WhisperWorkerEngine` crash backoff base | default `100` ms | `WhisperWorkerEngine.ts:100` (`crashBackoffBaseMs ?? 100` at `:125`) |
| `WhisperWorkerEngine` backoff formula | `delay = crashBackoffBaseMs * 2^(attempt-1)` → 100/200/400 ms, **uncapped** | `WhisperWorkerEngine.ts:527` |
| ONNX WASM thread clamp | `MAX_ORT_THREADS = 8` | `whisper.worker.ts:98` |
| `WebSocketClient` max reconnect attempts | default `3` | `WebSocketClient.ts:83` |
| `WebSocketClient` reconnect base delay | default `1000` ms | `WebSocketClient.ts:84` |
| `WebSocketClient` keep-alive interval | default `25000` ms | `WebSocketClient.ts:85` |
| `WebSocketClient` connection timeout | default `10000` ms | `WebSocketClient.ts:86` |
| `WebSocketClient` backoff cap | `RECONNECT_BACKOFF_CAP_MS = 30_000` ms | `WebSocketClient.ts:94` |

**ONNX thread resolution** (`whisper.worker.ts:99-105`, `resolveOrtNumThreads`):
```ts
const isolated = globalThis.crossOriginIsolated === true;
if (!isolated) return 1;
const hwConcurrency = navigator?.hardwareConcurrency;
if (typeof hwConcurrency !== 'number' || !Number.isFinite(hwConcurrency) || hwConcurrency < 2) return 1;
return Math.min(MAX_ORT_THREADS, Math.floor(hwConcurrency));
```
Corroborated by `packages/stt/src/__tests__/numThreads-wiring.test.ts`: isolated + `hardwareConcurrency=8` → `numThreads=8` (`:112-127`); not isolated → `1` (`:129-140`); isolated but `hardwareConcurrency=undefined` → `1` (`:155-166`); isolated + `hardwareConcurrency=128` → clamped `≤8` (`:168-181`).

**`WebSocketClient` reconnect backoff formula** (full-jitter exponential, `WebSocketClient.ts:421-445`):
```ts
const exponential = this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
const window_ = Math.min(RECONNECT_BACKOFF_CAP_MS, exponential);
const delay = window_ * Math.random();
```
i.e. `delay = min(30000, base·2^attempt) · Math.random()` — full jitter over the *entire* window (not "equal jitter"). Corroborated by `websocket-backoff-destroyed.test.ts`: with `Math.random()` mocked to `0.5`, attempt 1 fires at 1000·2⁰·0.5=500ms (`:105-113`), attempt 2 at 1000·2¹·0.5=1000ms (`:119-123`), attempt 3 at 1000·2²·0.5=2000ms (`:125-131`); with `Math.random()`=1, every reconnect within a 6-cycle burn-through still fires inside the 30s cap (`:136-166`); `destroy()`/`disconnect()` reliably cancel a pending reconnect timer (`:168-217`); `destroy()` makes subsequent `connect()` reject with `/destroyed/i` (`:219-230`).

**`WhisperWorkerEngine` crash-recovery corroboration** — `worker-crash-recovery.test.ts` exercises the default-constructed engine (`new WhisperWorkerEngine()`, no options override, `:112,130,156,185`) and asserts against `vi.advanceTimersByTimeAsync(200)` for a mid-sequence retry (`:145`) consistent with the 100/200/400ms doubling.

**`worker-transferable.test.ts`** corroborates §1's Transferable claim exactly (`transferList` contains `audio.buffer`, `:74-89`).

Note: `WebSocketClient.sendAudio()` re-implements the float32→int16 clamp inline (`WebSocketClient.ts:311-317`) rather than reusing `float32ToInt16` from `audioResampler.ts` — duplicated logic between the two files.

---

## 8. `useSTT.ts` hook

**Exposed surface** (`UseSTTReturn`, `hooks/useSTT.ts:40-94`):
- State: `isReady`, `isProcessing`, `isLoading`, `currentTranscript: string`, `finalTranscripts: TranscriptionResult[]`, `lastTranscription`, `loadProgress: ModelLoadProgress | null`, `stats: STTStats | null`, `processor: STTProcessor | null`, `isAttached`, `providerType: STTProviderType`, `language: LanguageLocale`, `error: Error | null`.
- Methods: `attach()`, `detach()`, `transcribeSegment(audio)`, `clear()`, `setLanguage(language)`.
- `providerType` state defaults to `'remote'` (`useSTT.ts:158`), matching `DEFAULT_FEATURE_FLAGS.provider = 'remote'` (`types/index.ts:221`).

**Provider selection is NOT performed by `useSTT.ts` itself** — confirmed by grep: zero occurrences of `setStreamingTransport`, `streamingTransport`, or `pipelineId` in `hooks/useSTT.ts`. The hook only constructs `new STTProcessor({ ...currentOptions, onModelProgress })` (`:244-256`) and forwards whatever `STTOptions` it was given. All local/remote/streaming resolution lives inside `STTProcessor`:
- `resolveProviderType()` (`STTProcessor.ts:493-502`): `'local'` iff `options.features?.provider === 'local'`, else defaults to `'remote'`.
- Inside the remote branch, `initializeRemoteProvider()` (`:666-676`) chooses `StreamingBackendSTTProvider` iff `this.streamingTransport` was injected via `setStreamingTransport()` — and that injection, with its `pipelineId`, happens externally in `@arcaai/vox`'s `PluginManager.buildStreamingTransport()`, not in `packages/stt` at all (see §3).

`useSTT.ts` does drive **processor lifecycle** off a `configFingerprint` (`useMemo`, `:185-220`) — a JSON string of `{modelId, language, provider, diarization, codeSwitching, vadGate, returnTimestamps, task, voiceProfileId, voiceProfileReserved}`. Any change tears down and reconstructs the whole `STTProcessor` (`useEffect` dep array `:229-291`), including releasing warm local-provider pool entries via `processor.releaseWarmResources()` (`:286`) — so a `features.provider`/`features.modelId` change does cause a full rebuild, but the *choice* of provider class is resolved downstream inside `STTProcessor`, not by the hook.

Auto-attach: `autoAttach` option defaults to `true` (`:146`); an effect calls `attach()` once `track` is non-null and not yet attached, and `detach()` when `track` goes null (`:434-443`).

---

## WebSocketClient.ts wiring status (explicit ask)

**`packages/stt/src/websocket/WebSocketClient.ts` is a legacy/near-dead class in the live pipeline, not actively used by the modern streaming path.**

- Its **only** non-test importer anywhere in `packages/` / `apps/` (excluding worktrees/node_modules) is `packages/stt/src/providers/BackendSTTProvider.ts:10` (the deprecated `RemoteSTTProvider` class). It is re-exported from the package barrel (`packages/stt/src/index.ts:196-197`, `websocket/index.ts:8-13`) but nothing outside `packages/stt` imports it directly.
- `RemoteSTTProvider` itself carries an explicit `@deprecated TASK-298 D-4` tag (`BackendSTTProvider.ts:18-22`) and is only reached by `STTProcessor.initializeRemoteProvider()` when **no** `streamingTransport` has been injected (`STTProcessor.ts:666-676`).
- In the actual SDK wiring, `PluginManager.buildStreamingTransport()` (`packages/agentic-sdk-v2/src/core/PluginManager.ts:743-772`) constructs `StreamingSessionManager` + `SttV2WebSocketClient` and injects them as the `streamingTransport` **whenever a `pipelineId` is configured and the provider isn't `'local'`** — which is the standard runtime configuration. Only if `pipelineId` is absent or `apiClient` is missing does it fall through to the legacy path.
- The real, actively-used WebSocket client for backend streaming is `SttV2WebSocketClient` in `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` (used by `PluginManager.ts:758`, `apps/admin-console/.../use-live-stt-session.ts:278`, `apps/ui-playground/.../use-realtime-transcription.ts:182`) — covered by the other researcher, not duplicated here.
- Net effect: `packages/stt/src/websocket/WebSocketClient.ts` + `MessageHandler.ts` + `RemoteSTTProvider` form a self-contained legacy protocol island (own reconnect backoff, own keep-alive, own JSON/binary framing) that is retained for callers passing a bare `sttSocket` URL but is not part of the pipeline-aware production streaming path.

---

## Key file paths referenced

- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/package.json`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/engines/{BaseEngine,WhisperEngine,WhisperWorkerEngine,errors,types,index}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/workers/whisper.worker.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/websocket/{WebSocketClient,MessageHandler,index}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/providers/{BackendSTTProvider,StreamingBackendSTTProvider,LocalSTTProvider,BaseSTTProvider,LocalSpeakerDiarizer,types,index}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/core/{STTProcessor,AudioBufferManager,audioCapture,index}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/worklets/stt-capture.worklet.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/utils/audioResampler.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/hooks/useSTT.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/types/index.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/index.ts`
- Corroborating tests: `packages/stt/src/__tests__/{numThreads-wiring,worker-crash-recovery,worker-transferable,websocket-backoff-destroyed}.test.ts`
- Cross-package wiring checked: `packages/agentic-sdk-v2/src/core/PluginManager.ts`, `packages/room/src/processors/{types,BaseProcessor}.ts`

(No report file was written — this is the complete, final output.)
