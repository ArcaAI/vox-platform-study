> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `explorer` `a970f06c3ec97f93b` (top-level; consolidates its five sub-explorers, captured individually as 12–16 and 18). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# HOPE Realtime Transcription Pipeline — Technical Map (Browser Mic → Transcript Render)

Repo root: `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2`. All citations exclude `.claude/worktrees/*` (stale duplicate worktrees present on disk) and `node_modules`/`dist`. Verbatim values are copied from source, not paraphrased.

---

## 1. `packages/room/` — Audio Capture

**getUserMedia constraints.** Default object built by `buildAudioConstraints()`, `packages/room/src/utils/constraints.ts:15-46`, from `DEFAULT_AUDIO_OPTIONS`:
```ts
// packages/room/src/types/index.ts:51-57
export const DEFAULT_AUDIO_OPTIONS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: false,
  channelCount: 1,
};
```
`sampleRate`/`deviceId`/`latency` are added to the constraints object only if explicitly passed in `AudioCaptureOptions` (`constraints.ts:26-38`) — **no sample rate is forced by default**, the browser picks its native rate. This builder is consumed by `AudioTrack.initialize()`: `navigator.mediaDevices.getUserMedia({ audio: constraints })` (`packages/room/src/core/AudioTrack.ts:141-145`).

**Critical finding — this builder is bypassed by the actual SDK entry point.** `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:99-101` (the real `audio.start()` implementation) calls `getUserMedia` directly, **not** through `@arcaai/room`'s constraint builder:
```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: options?.deviceId ? { deviceId: { exact: options.deviceId } } : true,
});
```
So the production capture path never explicitly requests `echoCancellation`/`noiseSuppression`/`autoGainControl`/`channelCount` — it relies on whatever the browser defaults to for `audio: true`. `packages/room`'s carefully-defaulted constraint builder is live code but not on the vox-SDK's own hot path (still exercised by `useAudioTrack`/other consumers).

**AudioContext.** `createAudioContext()`, `packages/room/src/core/AudioContextManager.ts:350-373`: `{ latencyHint: this.options.latencyHint ?? 'interactive' }`, `sampleRate` only set if passed. `DEFAULT_ROOM_OPTIONS = { webAudioMix: true, latencyHint: 'interactive' }` (`types/index.ts:157-160`) — no default sample rate at the room-package level. **Two production call sites force `sampleRate: 48000`**: `useArcaAudio.ts:103` (`AudioContextManager.getInstance({ sampleRate: 48000 })`) and `packages/room/src/hooks/useAudioMixer.ts:49`. Neither passes `requireSampleRate` for enforcement — `AudioContextManager.acquire({ requireSampleRate, allowMismatch })` (`AudioContextManager.ts:150-204`) exists to throw/warn on a mismatch but no production caller opts in (doc at `:14-19` explicitly warns downstream processors "hard-code" 48kHz/16kHz and "silently degrade" on mismatch).

**AudioWorkletNode vs ScriptProcessorNode.** `packages/room` itself creates neither (only the generic `createWorkletLoader` factory, `packages/room/src/utils/workletLoader.ts:42-83`, blob-URL + `addModule` caching, reused by noise-filter/vad/stt). Actual nodes live in `noise-filter` (§2).

**AudioTrack class** (`packages/room/src/core/AudioTrack.ts:91-650`) — lifecycle `IDLE→INITIALIZING→ACTIVE`/`MUTED`/`ENDED`/`ERROR`; processor attach via `setProcessor()` (`:281-324`, mutex-guarded by an internal `AsyncLock`, `:19-44`); level metering via `AnalyserNode.fftSize=2048` (`:447`) polled every `audioLevelInterval ?? 50`ms (`:458`) with a pre-allocated `Float32Array` reused per tick (`:450`, explicit anti-GC-churn comment). The only channel raw/processed audio leaves through is the `mediaStreamTrack` getter (`:203-205`, `currentProcessor?.processedTrack ?? sourceTrack`) — a live `MediaStreamTrack` reference, never a sample callback.

**AudioMixer** (`packages/room/src/core/AudioMixer.ts`, 150 lines) — GainNode summation, not `ChannelMergerNode` (doc `:28-30`): each `addSource(id, stream, gain=1.0)` creates its own `GainNode` into a shared `masterGain`; multiple `connect()` calls to one node auto-sum per the Web Audio spec. Normalization: `updateMasterGain()` (`:145-149`) sets `masterGain.gain = 1/√activeCount` (2 sources → `0.7071`). **Sample-rate/channel-count mismatch between primary and secondary devices is NOT handled anywhere** — no `sampleRate`/`channelCount` reference exists in `AudioMixer.ts` (confirmed by full read + grep); whatever the browser's Web Audio spec does implicitly at the `MediaStreamAudioSourceNode` boundary is the only mitigation. Real call site: `useArcaAudio.ts:112-132` (`mixer.addSource('primary', stream); mixer.addSource('secondary', secondaryStream);`) — neither `getUserMedia` call for either device requests an explicit rate.

**Resampling.** `resampleAudio(samples, fromRate, toRate)` — linear interpolation — `packages/room/src/utils/audioUtils.ts:137-156`. **Never called inside `packages/room` or `packages/noise-filter` itself** (confirmed by grep); it's a utility consumed by `packages/vad` and `packages/stt` (§3, §4).

**Frame/chunk sizes.** The Web Audio 128-sample render quantum is never overridden inside `packages/room`. `AudioTrack`'s own level-metering is a 50ms-interval `AnalyserNode` poll, not a frame pipeline.

**Backpressure.** `packages/room/src/core/ProcessorPipeline.ts` (§ordering below) has no queue/bound/drop policy at all — confirmed by grep for `ring ?buffer|backpressure|drop` returning zero hits outside tests. If a downstream processor is slower than capture, nothing in `packages/room` protects against it; the only bounded ring buffer in this hop lives inside `noise-filter` (§2).

**ProcessorPipeline ordering** (`packages/room/src/core/ProcessorPipeline.ts:32-253`) is **config-driven via a numeric `priority`**, not hardcoded: `add(processor, {priority})` (`:64-73`) stores `priority ?? processors.length*10`; `sortProcessors()` (`:227-229`) sorts ascending (lower runs first); `buildPipeline()` (`:168-196`) threads each processor's `processedTrack` into the next as input `track`. The actual production order (noiseFilter→VAD→STT) is fixed one layer up, in `@arcaai/vox`'s `TranscriptionPipeline` (§5), not in this package.

---

## 2. `packages/noise-filter/` — RNNoise WASM

**Chain position.** `NoiseFilterProcessor extends BaseProcessor` (from `@arcaai/room`) and is attached via `AudioTrack.setProcessor()`. `onInit()` (`packages/noise-filter/src/processors/NoiseFilterProcessor.ts:102-145`) receives the **raw, unprocessed mic track** + shared `AudioContext`, and builds its own subgraph: `MediaStreamAudioSourceNode(new MediaStream([track])) → RNNoise AudioWorkletNode → MediaStreamAudioDestinationNode` (`:124-170`); `this.processedTrack = destinationNode.stream.getAudioTracks()[0]` (`:139`) is what `AudioTrack.mediaStreamTrack` subsequently returns downstream.

**Frame size — exact, RNNoise-classic.** `RNNOISE_FRAME_SIZE = 480` (480 samples = 10ms @ 48kHz), declared identically in three places that must stay in sync: `packages/noise-filter/src/processors/RNNoiseProcessor.ts:27`, `packages/noise-filter/src/worklets/rnnoise.worklet.ts:25`, and the inline blob-string mirror in `packages/noise-filter/src/worklets/worklet-loader.ts:31`. `RNNOISE_SAMPLE_RATE = 48000` (`RNNoiseProcessor.ts:32`) — but this constant is used **only** for a stats/latency display calc (`getStats()`, `:209`); the worklet computes the equivalent from the live `sampleRate` AudioWorkletGlobalScope global instead (`rnnoise.worklet.ts:221`) — **the two "sample rate" sources of truth are never cross-checked**.

**Sample-rate enforcement — none inside noise-filter itself.** `NoiseFilterOptions.sampleRate` defaults to `48000` (`packages/noise-filter/src/types/index.ts:105`) but is read exactly once, only for a debug-log dump (`NoiseFilterProcessor.ts:112`) — **no code path validates the live `AudioContext.sampleRate` against 48000 or resamples internally**. The only enforcement mechanism in the whole stack is the opt-in `AudioContextManager.acquire({requireSampleRate})` (§1), which no noise-filter/VAD/STT caller actually invokes.

**Frame accumulation → 480-sample batching**, identical logic in the worklet (`rnnoise.worklet.ts:173-178`) and main-thread fallback (`RNNoiseProcessor.ts:141-147`): 128-sample render quanta (or 4096-sample `ScriptProcessorNode` buffers) are accumulated into `inputBuffer` until `bufferIndex >= 480`, then processed as one WASM call.

**Backpressure — one bounded ring buffer, drop-oldest.** `outputRingCapacity = RNNOISE_FRAME_SIZE * 2` = **960 samples** (`RNNoiseProcessor.ts:64`, `rnnoise.worklet.ts:65`). On overflow: `outputRingRead = (outputRingRead+1) % capacity; outputRingSize--; framesDropped++` (`RNNoiseProcessor.ts:183-189`, identical at `rnnoise.worklet.ts:206-210`) — silently increments a counter, surfaced only via polled `NoiseFilterStats.framesDropped`; no event fires at drop time. This ring only smooths the one-frame priming latency between "accumulate 480 in" and "emit 1 out per input sample" — not a cross-thread backpressure signal.

**Bypass conditions — exact code:**
```ts
// NoiseFilterProcessor.ts:130-136
if (isRNNoiseSupported() && this.options.noiseCancellation) {
  await this.initWorkletProcessing(audioContext);
} else {
  this.initNativeFallback();   // pure passthrough, no RNNoise at all
}
```
`isRNNoiseSupported()` (`packages/noise-filter/src/utils/browserSupport.ts:98-104`): `hasWasm && hasAudioContext && (audioWorklet || scriptProcessor)`. **`crossOriginIsolated`/`SharedArrayBuffer` do NOT gate RNNoise** (confirmed: `sharedArrayBuffer` is computed but never AND'ed into `rnnoiseSupported`, `browserSupport.ts:117`; RNNoise is single-threaded WASM). A worklet-init failure — including a hardcoded **10000ms timeout** (`NoiseFilterProcessor.ts:189-191`) — falls back to `ScriptProcessorNode` (buffer size **4096**, `:258`) with a `console.warn` (`:174`). Total failure of both `rnnoiseSupported` and `nativeFallbackAvailable` throws `NoiseFilterError(NOT_SUPPORTED)` (`:119-121`).

**Confirmed AudioWorkletProcessor** (real-time audio thread, not main thread): `class RNNoiseWorkletProcessor extends AudioWorkletProcessor` (`rnnoise.worklet.ts:44`), `registerProcessor('rnnoise-worklet-processor', ...)` (`:267`). WASM instantiated with a hand-ported import object matching `@jitsi/rnnoise-wasm@0.2.1`'s single-letter export ABI (`{a:{a: resize_heap, b: memcpy_big}}`, `worklet-loader.ts:9-11`, mirrored at `rnnoise.worklet.ts:137`) — the worklet and main-thread loader (`rnnoiseModule.ts`) must independently reimplement the same Emscripten glue because AudioWorklets cannot `import` npm packages at runtime.

---

## 3. `packages/vad/` — Silero VAD

**Version.** Silero **v5** is default and the only actively-wired model: `DEFAULT_VAD_OPTIONS.model: 'v5'` (`packages/vad/src/types/index.ts:143`). `'legacy'` (v4-class, 1536-sample frame) is auto-selected only for Safari-without-AudioWorklet or iOS (`getRecommendedModel()`, `packages/vad/src/utils/browserSupport.ts:127-137`). Library: `@ricky0123/vad-web@0.0.30` (`VAD_WEB_VERSION`, `packages/vad/src/constants.ts:25`) — `VADProcessor` is a thin wrapper around its `MicVAD` class; **`VADProcessor` does not run ONNX inference itself**.

**Asset loading — CDN by default.** `DEFAULT_BASE_ASSET_PATH = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/'` (`constants.ts:40`), `DEFAULT_ONNX_WASM_BASE_PATH = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/'` (`constants.ts:49`, `ORT_WEB_VERSION='1.27.0'`, `:31`). Neither `TranscriptionPipeline.ts` nor `PluginManager.ts` override these — **production wiring fetches the VAD model + ONNX WASM binaries from a public CDN on every session start** unless an app-level consumer overrides `baseAssetPath`/`onnxWASMBasePath`. The file header documents a past incident from exactly this kind of version drift (`constants.ts:14-18`: a prior CDN/installed-package mismatch "made inference silently fail in self-hosted defaults").

**ONNX Runtime.** Package `onnxruntime-web@1.27.0` (exact-pinned devDependency, `packages/vad/package.json:77`). No explicit backend/SIMD string set anywhere in `packages/vad/src` (grep confirmed) — only `ort.env.wasm.numThreads` is touched. Thread resolution, `resolveOrtNumThreads()` (`packages/vad/src/processors/VADProcessor.ts:40-46`):
```ts
const MAX_VAD_ORT_THREADS = 8;                                    // :39
if (!crossOriginIsolated) return 1;                                // :42
if (!hardwareConcurrency || hardwareConcurrency < 2) return 1;     // :44
return Math.min(8, Math.floor(hardwareConcurrency));                // :45
```
Applied via `configureOrtThreads()` at the top of every `initMicVAD()` call (`:276`).

**Thresholds — exact package defaults**, `DEFAULT_VAD_OPTIONS` (`packages/vad/src/types/index.ts:142-155`):

| Constant | Value |
|---|---|
| `positiveSpeechThreshold` | `0.5` |
| `negativeSpeechThreshold` | `0.35` |
| `preSpeechPadMs` | `300` |
| `postSpeechPadMs` | `300` |
| `minSpeechMs` | `250` |
| `redemptionMs` | `1400` |
| `sampleRate` | `16000` |
| `silenceResetMs` | `5000` |

`postSpeechPadMs` is **not** a native `vad-web` option — `VADProcessor` implements it itself by zero-padding the returned buffer (`appendPostSpeechPad()`, `VADProcessor.ts:421`), since upstream only exposes `preSpeechPadMs`/`redemptionMs`.

**Production override diverges from the package default.** `TranscriptionPipeline.ts:144-151` (`packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`) constructs the live instance with `redemptionMs: this.config.vad.minSilenceDuration ?? 500` and `minSpeechMs: this.config.vad.minSpeechDuration ?? 250`, where `DEFAULT_VAD_CONFIG = {sensitivity:0.5, minSpeechDuration:250, minSilenceDuration:500}` (`packages/agentic-sdk-v2/src/core/constants.ts:966-971`) — **the shipped `redemptionMs` (speech-end silence hang time) is effectively 500ms, not the package's own 1400ms default (2.8× difference)**. Negative-threshold formula also diverges between two code paths: `TranscriptionPipeline.getVADNegativeThreshold` uses `max(0.1, min(0.95, positive - 0.15))` (`TranscriptionPipeline.ts:632-634`) while `PluginManager`'s live-sensitivity-update path uses `positive * 0.7` (`PluginManager.ts:664-666`, its own comment claims to "mirror" the former but doesn't) — they coincide only at the default `0.5`.

**Frame size — 512 samples for v5** (`FRAME_SIZE_V5=512`, `packages/vad/src/utils/frameProcessor.ts:13`; cross-confirmed `getFrameSamplesForModel()`, `browserSupport.ts:142-144`). **Caveat:** `FrameAccumulator`/`AudioRingBuffer` (the classes that consume this constant) are exported public API but **not imported by `VADProcessor.ts`** — the real-time 512-sample framing happens inside `@ricky0123/vad-web`'s own internal worklet, external to this repo; `FrameAccumulator` is dead code w.r.t. the shipped path.

**Resampling.** `VAD_SAMPLE_RATE=16000` (`packages/vad/src/utils/resampler.ts:13`). `VADProcessor` does **not** import or use `resampler.ts` at all — it hands the raw, unresampled `MediaStream` straight to `MicVAD.new({..., getStream: async () => stream})` (`VADProcessor.ts:279-325`); resampling from the AudioContext's native rate to 16kHz happens inside `vad-web`'s internal worklet. `resampler.ts`'s own linear-interpolation implementation (delegating to `@arcaai/room`'s `resampleAudio`) is likewise unused by the real-time path.

**Events emitted** (all via `BaseProcessor.emitData()`): `'vad-speech-start'`, `'vad-speech-real-start'`, `'vad-speech-end'` (payload includes the padded `Float32Array` audio + segment metadata), `'vad-misfire'`, `'vad-frame'` (per-frame probability), `'vad-stats'`. `isSpeechFrame = probability > positiveSpeechThreshold` (`VADProcessor.ts:481`, strictly-greater).

**Downstream consumption.** `TranscriptionPipeline.handleVADEvent()` (`packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts:686-748`) re-emits speech-start/end/misfire as a generic `vadEvent` (UI/telemetry). **Critically, VAD only hard-gates continuous STT audio sends for the local/browser Whisper path**: `useVadGate = runtimeProvider === 'local' && vad.enabled` (`TranscriptionPipeline.ts:166`) forwards `vadGate: true` into `STTProcessor`'s per-frame capture callback, which then **skips every continuous frame** (`if (features?.vadGate) return;`, `packages/stt/src/core/STTProcessor.ts:773-775`) and instead transcribes only on VAD's `'vad-speech-end'` via `sttProcessor.transcribeSegment(data.audio)` (`TranscriptionPipeline.ts:712-721`). **For the remote/backend-streaming path (typical production config), `useVadGate` is always false — VAD output is UI/telemetry-only and never gates or triggers the streaming transcription send**; `STTProcessor` keeps streaming every captured frame to the WS regardless of speech/silence state.

---

## 4. `packages/stt/` — Local Whisper + Legacy WS Transport

**Local Whisper — model ID formula.** `BaseEngine.getModelId()` (`packages/stt/src/engines/BaseEngine.ts:67-75`):
```ts
const prefix = quantized ? 'onnx-community' : 'Xenova';
return `${prefix}/whisper-${model}${modelSuffix}${timestampSuffix}`;
```
e.g. `model='tiny'`, `language='en-US'`, quantized (default) → **`onnx-community/whisper-tiny.en`**. `BROWSER_LOADABLE_WHISPER_SIZES = ['tiny','base','small']` (`packages/stt/src/types/index.ts:991`) — `medium`/`large` excluded because `onnx-community/whisper-large-v3` is gated and 401s; `DEFAULT_LOCAL_WHISPER_SIZE = 'base'` (`:997`). Library: `@huggingface/transformers@4.2.0` (exact-pinned, `packages/stt/package.json:56-59`, backed by `onnxruntime-web@1.27.0`) — **not** `@xenova/transformers`. `quantized` is *not* a `dtype` param — it only selects the HF repo prefix; the actual dtype split is WebGPU-only fp16: `dtype = device==='webgpu' ? {encoder_model:'fp16', decoder_model_merged:'fp16'} : undefined` (identical in `WhisperEngine.ts:79-81` and `whisper.worker.ts:205-214`) — WASM always runs default (fp32) precision.

**Runs inside a dedicated WebWorker.** `LocalSTTProvider.init()` (`packages/stt/src/providers/LocalSTTProvider.ts:93-95`) **always** constructs `WhisperWorkerEngine` (never `WhisperEngine` directly); the Worker is spawned as `new Worker(new URL('./workers/whisper.worker.mjs', ...), {type:'module'})` and falls back to main-thread `WhisperEngine` only if `Worker` is unsupported. Transfer protocol is zero-copy: `postMessage({type:'transcribe', audio, ...}, [audio.buffer])` (`WhisperWorkerEngine.ts:373-387`) — avoids a ~1.9MB structured-clone per 30s chunk (comment cites TASK-270); the caller's `audio` view is detached after the call.

**Local buffering.** `AudioBufferManager` defaults: `chunkLengthS=30`, `overlapLengthS=5`, `minBufferS=1` (`packages/stt/src/core/AudioBufferManager.ts:43-48`) → 480000/80000/16000 samples @16kHz. Growing-array buffer (not a ring buffer), sliding-window chunking on `getChunk()` (`:138-162`). **No overflow/backpressure cap inside the manager itself** — `LocalSTTProvider` polls every **500ms** (`setInterval(...,500)`, `LocalSTTProvider.ts:138-140`) and drains with a single-flight `isTranscribing` guard; if inference is slower than capture the buffer keeps growing between polls. In practice this 30s/5s buffer path is largely bypassed when VAD-gating is active (§3) — segments are transcribed at VAD speech-end instead.

**Capture graph.** `audioCapture.ts` taps the **same shared track/AudioContext** `@arcaai/room` hands to every pipeline stage (own `MediaStreamAudioSourceNode` + `AudioWorkletNode`, mirroring the vad/noise-filter pattern) — not a redundant parallel path, but an architecturally-separate graph tap. Worklet coalescing: `DEFAULT_STT_CAPTURE_FRAME_MS = 80` (`packages/stt/src/worklets/stt-capture.worklet.ts:36`) — 128-sample render quanta batched into `targetSamples = round(sampleRate*frameMs/1000)` and posted as one `Transferable` frame per fill, cutting message rate from ~375/s to **~12/s** at the default (doc `:8-13`). `ScriptProcessorNode` fallback buffer: **4096 samples** (`audioCapture.ts:21`). `STTProcessor.onInit()` builds a *second*, independent `MediaStreamAudioSourceNode` from the same track for pass-through (`STTProcessor.ts:215-219`) — two source nodes per attach cycle, not one shared.

**Resampling to Whisper's target rate.** `WHISPER_SAMPLE_RATE = 16000` (`packages/stt/src/utils/audioResampler.ts:17`). **Algorithm: anti-aliased Kaiser-windowed-sinc polyphase resampler**, `resampleSinc()` (`audioResampler.ts:230-248`), used by `prepareFloat32ForWhisper()` — the hot path for both `AudioBufferManager.append()` and `StreamingBackendSTTProvider.processAudio()`. Constants: `SINC_TAPS_PER_BRANCH=32`, `KAISER_BETA=9` (~90dB stopband attenuation), `SINC_CUTOFF_RATIO=0.45`, `MAX_POLYPHASE_BRANCHES=1024`. A legacy `resampleLinear()` (delegating to room's `resampleAudio`) exists "for backward compatibility" but is **not** on the hot path.

**Legacy WS transport (`packages/stt/src/websocket/WebSocketClient.ts` + `MessageHandler.ts`) — confirmed dead-code island.** Its only non-test importer anywhere is `packages/stt/src/providers/BackendSTTProvider.ts` (class name `RemoteSTTProvider`, tagged `@deprecated TASK-298 D-4`). Own reconnect params: `maxAttempts=3`, `baseDelayMs=1000`, `keepAliveInterval=25000`, `connectionTimeout=10000`, `RECONNECT_BACKOFF_CAP_MS=30000` (`WebSocketClient.ts:83-94`) — full-jitter formula `delay = min(30000, base·2^attempt)·Math.random()`. Own client-side audio batching: `audioQueue` flushed every `SEND_INTERVAL_MS=100` once `MIN_SAMPLES_TO_SEND=1600` samples queued (`BackendSTTProvider.ts:67-68`). This provider is only reached by `STTProcessor.initializeRemoteProvider()` when **no** `streamingTransport` was injected (`STTProcessor.ts:666-676`) — i.e. only when `pipelineId` is absent. **The real production backend-streaming client is `SttV2WebSocketClient` in `packages/agentic-sdk-v2`** (§5), not this package.

---

## 5. `packages/agentic-sdk-v2/` — SDK Wiring, Backend WS Client, Store, UI

### 5a. `audio.start({pipelineId, language, deviceId, secondaryDeviceId})` trace

`AudioStartOptions` (`packages/agentic-sdk-v2/src/types/audio.ts:269-297`): `{language?, pipelineId?, deviceId?, secondaryDeviceId?, dualCaptureEnabled?, onDualCapture?}`. `useArcaAudio.startAudio()` (`packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:62-293`) does **not** itself branch local-vs-backend — it forwards `pluginManager.setRuntimeOptions({pipelineId, consultationId, language})` (`:80-84`). The actual branch is in `PluginManager.buildStreamingTransport()` (`packages/agentic-sdk-v2/src/core/PluginManager.ts:743-773`):
```ts
buildStreamingTransport(sttConfig, pipelineId) {
  if (!pipelineId) return undefined;
  if (!this.apiClient) return undefined;
  if ((sttConfig.provider ?? DEFAULT) === 'local') return undefined;
  const sessionManager = new StreamingSessionManager(this.apiClient, this.logger);
  const wsClient = new SttV2WebSocketClient(this.logger, {enabled:true, refreshTicket: () => sessionManager.refreshTicket()}, debugMode);
  return { sessionManager, wsClient, pipelineId, consultationId };
}
```
Final local-vs-remote resolution: `TranscriptionPipeline.resolveSTTRuntimeProvider()` (`TranscriptionPipeline.ts:611-618`) — defaults to `'remote'` whenever `sttSocket` or `streamingTransport` exists.

`deviceId`/`secondaryDeviceId` feed `@arcaai/room`'s `AudioMixer` directly inside `useArcaAudio.ts:98-132` (see §1's critical finding re: bypassed constraint builder).

### 5b. Pipeline order

Hardcoded via `priority`, `TranscriptionPipeline.setupStageFactories()` (`packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts:119-217`): `noiseFilter: priority 10`, `vad: priority 20`, `stt: priority 30`, executed by `getEnabledStages().sort((a,b)=>a.priority-b.priority)` (`:639-643`), each stage's `processedTrack` chained as the next stage's input. `TranscriptionPipelineConfig` does carry a per-stage `location` field, but unlike `KnowledgePipeline` (which genuinely branches `browser|backend|auto|disabled`), only `stt.location`/`stt.provider` actually branches execution — `noiseFilter`/`vad` have no backend implementation to branch to.

### 5c. `SttV2WebSocketClient.ts` (`packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts`, 1006 lines) — the real production backend transport

**URL construction** (built by `StreamingSessionManager`, not the client itself) — `packages/agentic-sdk-v2/src/core/StreamingSessionManager.ts:148-183`:
```ts
const wsOrigin = `${wsProtocol}//${parsed.host}`;                 // from apiClient.getWsUrl() ?? getBaseUrl()
const wsPath = sessionResponse.wsUrl || STT_V2_ENDPOINTS.WS_STREAM; // '/ws/stt-v2/stream'
params = { sessionId, ...(ticket && {ticket}), ...(tenantId && {tenantId}) };
return `${wsOrigin}${wsPath}?${params}`;
```
`STT_V2_ENDPOINTS` (`packages/agentic-sdk-v2/src/core/constants.ts:367-379`): `CREATE_SESSION: '/audio/transcription-jobs/stream/session'`, `REFRESH_TICKET: (id) => '.../stream/session/${id}/refresh-ticket'`, `WS_STREAM: '/ws/stt-v2/stream'`.

**Auth.** `StreamingSessionManager.createSession()` does `POST STT_V2_ENDPOINTS.CREATE_SESSION` first (`StreamingSessionManager.ts:81-135`), receiving a one-shot `ticket` that is appended as `?ticket=` on the WS URL — **never as a first control frame** (the doc comment at `getWebSocketUrl():141-146` describes an `{type:'auth',token}` pattern that is never actually sent anywhere in the code). A fail-closed tenant-claim guard also runs pre-connect: `requireTenantClaim` defaults `true` (`SttV2WebSocketClient.ts:223`), rejecting before any socket opens if no `tenantId`/`tenant` resolves from the URL or `options.tenantClaim`.

**Outgoing audio — raw binary Int16LE, not JSON/base64, in the real path.** Two send methods exist; only one is used at runtime:
```ts
// SttV2WebSocketClient.ts:355-363 — the live path
sendAudioFrame(data: ArrayBuffer | ArrayBufferView): boolean {
  if (shouldDropForBufferedAmount()) { dropFrame('buffered_amount_high'); return false; }
  this.ws.send(data); return true;
}
// sendAudioFrameJson() (:370-382) exists but is never called by any production caller
```
Real caller: `StreamingBackendSTTProvider.processAudio()` (`packages/stt/src/providers/StreamingBackendSTTProvider.ts:225-243`) — `prepareFloat32ForWhisper()` (resample to 16kHz) → `float32ToInt16()` → `wsClient.sendAudioFrame(int16)` (zero-copy typed-array view, per-call, **no client-side send-interval throttle**). Chunking cadence is set entirely by the upstream worklet coalescing constant (§4: 80ms default), not by any timer in the WS client.

**Control frames — exact JSON, verbatim:** `sendStop()` → `{"type":"stop"}` (`:402-405`); `sendClose()` → `{"type":"close"}` (`:410-413`); auto-fired resume handshake on reconnect-open → `{type:'resume', sessionId, lastSeq}` (`:988-1005`).

**Incoming schema.** `WsTranscriptResult` (strict, post-normalize, `types/stt-v2.ts:193-245`): `{type:'transcript', text, startTime, endTime, isFinal, stableChars?, utteranceIndex?, resultType?('segment'|'gloss'), seq?, englishText?, speakerId?, speakerLabel?, speakerConfidence?, speakerEmbedding?, speakerFeatures?, wordTimestamps?, inference?}`. `normalizeTranscript()` (`:650-787`) tolerantly coerces dual-cased wire fields (`start_time`/`startTime`, `is_final`/`isFinal` accepting bool/`1`/`0`/`'1'`/`'0'`); a payload missing `text` is the only thing dropped outright. Other message types: `WsStatusMessage{type:'status',status,message}`, `WsErrorMessage{type:'error',code,message}`, `WsResumedMessage{type:'resumed',sessionId,fromSeq}`, `WsResumeFailedMessage{type:'resume_failed',sessionId,reason,minAvailableSeq?}`.

**Reconnect backoff — exact formula and defaults** (`SttV2WebSocketClient.ts:194-200, 545-547`):
```ts
maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 30_000
exponentialDelay = min(baseDelayMs * 2^(attempts-1), maxDelayMs)
delay = exponentialDelay + Math.random() * exponentialDelay * 0.5   // additive 0–50% jitter, NOT full-jitter
```
Before every attempt, `refreshTicket()` (wired to `sessionManager.refreshTicket()`) mints a fresh ticket and rewrites the URL — a refresh failure aborts the reconnect (`onReconnectFailedCb` fires). `acknowledgeConnection()` resets the attempt counter on the first server message received after a reconnect (TASK-2605) so a genuinely-stable reconnect gets a fresh budget for the *next* episode.

**Buffering during disconnect — dropped, not queued (despite doc claims of a bounded queue).** `WsBackpressureOptions`'s docblock describes an `audioQueue` with `maxQueueSize=200` drop-oldest policy (`:103-119, 140`) — **no such `audioQueue` field or queue-length check exists anywhere in the class** (confirmed by full read + grep). The only real backpressure mechanism is `ws.bufferedAmount >= 1 MiB` (`DEFAULT_BUFFERED_AMOUNT_HIGH_WATERMARK`, `:142`), which only applies while the socket is `OPEN`. While genuinely disconnected, the actual caller `StreamingBackendSTTProvider.processAudio()` guards with `if (!this.processing || !this.wsClient.isConnected()) return;` (`StreamingBackendSTTProvider.ts:226-228`) — **audio captured during a disconnect window is silently dropped at the provider level, with no queue and no replay on reconnect.**

**Finalize-on-stop — no wait for a tail-final response.** Full chain on `stopAudio()`: `useArcaAudio.stopAudio()` → `pluginManager.destroy()` → `transcriptionPipeline.destroy()` → `stage.processor.destroy()` for `'stt'` → `STTProcessor.onDestroy()` → `provider.stop()` then immediately `provider.destroy()`. `StreamingBackendSTTProvider.stop()` (`StreamingBackendSTTProvider.ts:213-223`) sends `{"type":"stop"}` and **returns immediately** — no listener registered for any "final"/"finalizing" acknowledgment. `destroy()` (`:250-264`), called right after in the same chain, calls `wsClient.disconnect()` — synchronous `ws.close(1000, 'Client disconnect')` (`SttV2WebSocketClient.ts:419-436`). **There is no state-machine gate, timeout, or Promise between `sendStop()` and the socket close** — see the closing section for the client-side race this creates with the gateway's own 0040fe3e fix.

### 5d. Transcript flow into the store

`useArcaAudio`'s `onTranscription` callback (`useArcaAudio.ts:135-216`): on `result.isFinal`, builds a `TranscriptSegment` and calls `store.addTranscriptSegment(segment)` (plain array append, no dedup — `agenticStore.ts:445`); on a partial, calls `store.setCurrentTranscript(result.text)` (scalar overwrite, `agenticStore.ts:443`). **Critical finding:** `StreamingBackendSTTProvider.normalizeTranscript()` (`packages/stt/src/providers/StreamingBackendSTTProvider.ts:301-320`) — the function that converts the WS client's rich `StreamingTranscriptPayload` into the generic `TranscriptionResult` — only copies `text/isFinal/language/duration/speakerId/confidence/words`. **The TASK-351/TASK-471 tentative-tail wire fields (`stableChars`, `resultType`, `utteranceIndex`) that `SttV2WebSocketClient.normalizeTranscript()` already parses (§5c) are dropped at this hop** and never reach `TranscriptionResult`/`TranscriptSegment`/the store. Combined with the fact that `useArcaAudio`'s `onTranscription` only ever constructs a `TranscriptSegment` inside the `isFinal===true` branch, `store.transcriptSegments` in practice **only ever contains fully-final entries** — partials only ever populate the plain scalar `currentTranscript` string, with no `stableChars`.

### 5e. Live transcript UI — tentative tail rendering

`packages/ui/src/components/live-transcript/types.ts` — `LiveTranscriptSegment` **does** carry `stableChars?: number` (documented as "a superset of the SDK store `TranscriptSegment` AND the wire `WsTranscriptResult`"). The actual split renders in `SegmentBody()`, `packages/ui/src/components/live-transcript/transcript-segment.tsx:158, 178-187`:
```tsx
const baseClass = cn('text-sm leading-relaxed', segment.isFinal ? 'text-foreground' : 'italic text-muted-foreground');
// stableChars: committed prefix renders settled; the tail renders tentatively.
if (!segment.isFinal && segment.stableChars != null && segment.stableChars > 0 && segment.stableChars < segment.text.length) {
  return (
    <p className={baseClass}>
      <span className="not-italic text-foreground">{segment.text.slice(0, segment.stableChars)}</span>
      <span>{segment.text.slice(segment.stableChars)}</span>
    </p>
  );
}
return <p className={baseClass}>{segment.text}</p>;
```
This exactly matches TASK-471's own citation (`transcript-segment.tsx:178-184`). The wrapper also sets `aria-live={segment.isFinal ? undefined : 'off'}` (`:84`) so interim rows don't spam screen readers. A separate, simpler `interim` prop (`live-transcript.tsx:153-161`) renders the live partial as flat, uniformly-italic text with **no `stableChars` slicing** at all.

**Given §5d, within this repo's default `useArcaAudio`/`agenticStore` wiring, the two-tone `stableChars` render path in `SegmentBody` is unreachable** — `transcriptSegments` entries are always `isFinal:true`, and `currentTranscript`/`interim` is a plain string with no `stableChars`. Exercising it requires a consumer to independently construct `LiveTranscriptSegment` objects with `isFinal:false`+`stableChars` from the raw WS payload, bypassing the default SDK hooks (plausible for the "external, out-of-repo" clinical vox UI referenced by TASK-464, but not demonstrated anywhere in this repo).

`JumpToLive` (`packages/ui/src/components/live-transcript/jump-to-live.tsx`) — floating button, shown when `!isPinnedToBottom` (`BOTTOM_THRESHOLD=24px`, `use-live-transcript.ts:47, 162`); the call site never passes `hasBacklog`, so the "New messages" label variant is dead in the shipped component (always reads "Jump to live"). Autoscroll effect fires on new final segments **or** new `interim` text, gated on `autoScroll && isPinnedToBottom` (`use-live-transcript.ts:177-181`). `ListeningPulse` (`listening-pulse.tsx`) — a `bg-primary` dot with `animate-ping` overlay (`motion-reduce:hidden`) when `active`, fully consumer-driven (no internal store read).

`DualStreamRecorder`/`ProcessedAudioTap` (`packages/agentic-sdk-v2/src/core/`) — parallel raw+processed `MediaRecorder` capture for later QA playback, gated on `dualCaptureEnabled && workflowMode !== 'remote'` (local-workflow only today); `ProcessedAudioTap` is an unused escape hatch (no call sites found) intended to let a future remote/backend-streaming flow obtain a genuine post-RNNoise track for dual capture.

---

## 6. `apps/api/` Gateway — `SttWsGateway`, Redis Bridge, stt-v2

### 6a. End-to-end session/data flow

1. Browser `StreamingSessionManager.createSession()` → `POST /api/v1/audio/transcription-jobs/stream/session` → `TranscriptionJobController.createStreamSession()` (`apps/api/src/modules/streaming/transcription-job.controller.ts:312-407`), which calls `StreamingSessionService.createSession()` → `POST {STT_V2_URL}/internal/streaming/sessions` on stt-v2 (`packages/applications/src/services/stt/streaming/streamingSession.service.ts:66-124`, mapping camelCase→snake_case) → stt-v2's `create_streaming_session()` (`apps/stt-v2/src/stt_v2/streaming/api/routes.py:57-114`) creates the session via `SessionManager.create_session()` and returns `{session_id, status:'active', max_concurrent, current_active}` (or `503 Retry-After:5` at capacity).
2. The gateway mints a stream ticket: `streamTicketService.issueTicket({userId, tenantId, scope: 'stt_session:${sessionId}'})` (`transcription-job.controller.ts:384-388`) — Redis key `stream-ticket:<ticket>` (`STREAM_TICKET_KEY_PREFIX`, `apps/api/src/modules/auth/stream-ticket.service.ts:24`), **TTL 30s** (`STREAM_TICKET_TTL_SECONDS`, `:25`), payload `{userId, tenantId, scope, exp, impersonatedBy}` (`:51-58`), single-use via `GET` then unconditional `DEL` (`consumeTicket()`, `:82-118`). A second, generic issuance path also exists: `POST /api/v1/auth/stream-ticket` (`AuthController.issueStreamTicket`, `apps/api/src/modules/auth/auth.controller.ts:778`).
3. Browser opens `wss://<host>/ws/stt-v2/stream?sessionId=X&ticket=Y&tenantId=Z` — `@WebSocketGateway({ path: '/ws/stt-v2/stream' })` (`apps/api/src/modules/streaming/stt-ws.gateway.ts:160`).
4. `handleConnection()` (`:281-425`) validates in order: `sessionId` present → `ticket` present → `consumeTicket(ticket)` succeeds → `stored.scope === 'stt_session:${sessionId}'` → tenant-binding lookup (`StreamSessionTenantBindingService.lookup(sessionId) === stored.tenantId`, fail-closed on lookup error). **Every rejection path closes with the identical generic code/reason** (`WS_CLOSE_CODES.AUTH_FAILED = 4401`, `WS_GENERIC_AUTH_REASON = 'Authentication failed'`, `:29-38`) — no enumeration signal on the wire; the real cause only reaches the server warn log. On success: registers `SessionInfo`, subscribes to results (`WS_RESULT_CONSUMER_GROUP = 'captions'`), sends `{type:'ready', sessionId, fromSeq}` (`sendReady()`, `:463-465`) — a deterministic gate so the client never races registration.

### 6b. Audio/control forwarding — Redis Streams, not HTTP

`handleMessage()` (`stt-ws.gateway.ts:796-867`): binary WS frames route directly to `forwardAudioFrame()` via the `ws` library's `isBinary` flag (not `Buffer.isBuffer`, since `ws@8` delivers text frames as Buffers too — this misrouting was a prior bug per the inline comment, `:803-808`); JSON `{type:'audio', seq, data:<base64>}` decodes via `Buffer.from(data,'base64')`. Both call:
```ts
// forwardAudioFrame, stt-ws.gateway.ts:878-889 — fire-and-forget, no per-frame await
this.bridgeService.writeAudioFrame(sessionId, seq, data, session.sampleRate, 'pcm_s16le', false).catch(...);
```
`StreamingAudioBridgeService.writeAudioFrame()` (`packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts:232-267`) does `XADD stt:audio:{sessionId} MAXLEN ~ 10000 * seq <seq> sr <rate> enc pcm_s16le ch 1 data <raw buffer> final <0|1> ts <epoch>`. `AUDIO_STREAM_MAXLEN=10000` (`:20`). **The gateway hardcodes `enc='pcm_s16le'` regardless of what the client message declared** — no per-frame encoding negotiation. On `{type:'stop'}`: `bridgeService.writeControlCommand(sessionId, 'finalize')` → `XADD stt:control:{sessionId} action finalize` (`:279-293`).

stt-v2 side: `IngestionConsumer._run()` (`apps/stt-v2/src/stt_v2/streaming/redis_streams.py:303-388`) `XREADGROUP`s `stt:audio:{sessionId}` (`count=100, block=self._block_ms` default **5000ms**, `:143`) → `AudioFrame.from_redis_dict()` (`schemas.py:83-121`, raw bytes not base64) → `_dispatch_frame` → the per-session frame handler wired by `SessionManager.create_session()`. `ControlListener._run()` (`redis_streams.py:494-557`) similarly reads `stt:control:{sessionId}` (`block_ms=5000` default, `:504`).

### 6c. Result consumption — `XREADGROUP` consumer group

`StreamingAudioBridgeService.readResultStream()` (`streamingAudioBridge.service.ts:426-527`): stream key `stt:result:{sessionId}` (`:319`, matching stt-v2's `result_stream_key()`); the WS gateway subscribes with the **stable** group `WS_RESULT_CONSUMER_GROUP = 'captions'` (`stt-ws.gateway.ts:103`) so a reconnect resumes from the group's Redis-owned cursor rather than re-reading `0-0` (other subscribers like `LiveDocumentationService` default to a per-subscription unique group for fan-out). Exact call:
```ts
reader.xreadgroup('GROUP', group, consumer, 'COUNT', 100, 'BLOCK', RESULT_STREAM_BLOCK_MS /* = 500 */, 'STREAMS', streamKey, readId);
```
`readId` is `'0'` (drain this consumer's own pending entries first) until an empty reply, then `'>'` (live). `XACK` fires **after** emitting each entry (at-least-once). Dead-reader hand-off via `XAUTOCLAIM` with `RESULT_CLAIM_MIN_IDLE_MS = 30_000` (`:50`).

### 6d. The 0040fe3e fix — verbatim

`streamingAudioBridge.service.ts::parseAndEmitResult()` (current, `:609-693`):
```ts
// Terminal only on a true end-of-session status. `finalizing` is a progress
// marker that PRECEDES the tail final — treating it as terminal drops it.
if (data.type === 'status') {
  return data.status === 'closed' || data.status === 'cancelled';
}
```
Diff (before → after, `git show 0040fe3e`):
```diff
-      return data.status === 'closed' || data.status === 'finalizing';
+      return data.status === 'closed' || data.status === 'cancelled';
```
Root cause: pre-fix, the reader **completed on `finalizing`**, one entry before stt-v2 published the true tail FINAL. stt-v2's control handler publishes in the order `finalizing → FINAL → closed`: `_make_control_handler` (`apps/stt-v2/src/stt_v2/streaming/session_manager.py:1757-1781`) — on `FINALIZE`: `session.finalize()` → `publisher.publish_status("finalizing")` (`:1766`) → **then** `_flush_final_utterance()` (runs ASR on the remaining buffered audio and publishes the real FINAL, `:1769`) → `_drain_inference_queue()` → `_finalize_session()` (which eventually calls `publish_status("closed")`, `:2529`). The old code tore the reader down at `finalizing` and orphaned the tail FINAL in Redis — every streaming session silently dropped its last utterance.

`redis_streams.py` diff — both `IngestionConsumer._run` and `ControlListener._run` gained:
```python
except RedisTimeoutError:
    # A redis-py socket_timeout shorter than BLOCK surfaces here every time the
    # block elapses on a SILENT stream... BENIGN — treat it exactly like an
    # empty read and re-issue immediately... Deliberately NOT the fatal-error
    # path below: no error spam, no 1s backoff.
    continue
except Exception as exc:
    ...  # unchanged fatal path: logger.error + 1s backoff
```
`_runtime.py` diff — the streaming Redis client gained `health_check_interval=30` on `aioredis.from_url(settings.redis_url, decode_responses=False, health_check_interval=30)` (`apps/stt-v2/src/stt_v2/streaming/_runtime.py:102-106`) so a silently-dropped connection is detected on the next idle command. The commit explicitly deliberately sets **no** `socket_timeout` in committed code (the readers now tolerate whatever an operator/env injects).

### 6e. Egress backpressure, resume, grace window, heartbeats

- **Resume buffer**: `RESUME_BUFFER_SIZE = 200` transcripts per session (`stt-ws.gateway.ts:48`), each tagged with a monotonic `resultSeq` (`tagAndBuffer()`, `:687-698`).
- **Egress backpressure** (`relayResult()`, `:547-572`): when `client.bufferedAmount > WS_EGRESS_HIGH_WATERMARK_BYTES` (default **512 KiB**, env `STT_WS_EGRESS_HIGH_WATERMARK_BYTES`, `:62-65`) — **partial** transcripts are silently dropped (counted only, `droppedPartialResults++`); **final** transcripts are queued (bounded `WS_EGRESS_FINAL_QUEUE_LIMIT = 200`, `:73`) and flushed on a `WS_EGRESS_FLUSH_POLL_MS = 50`ms poll (`:80`) once the socket drains. On queue overflow the oldest queued final is dropped and an explicit `{type:'gap', reason:'egress_overflow', droppedSeq}` control frame is sent (`emitGapMarker()`, `:624-636`) — finals are never *silently* lost client-side, but partials are.
- **Resume grace window**: `WS_RESUME_GRACE_MS = 15_000` (env `STT_WS_RESUME_GRACE_MS`, `:90-93`) — on a transient WS disconnect, the gateway keeps the upstream stt-v2 session + resume buffer + `resultSeq` alive for 15s so the *same* session can reconnect (`rebindSession()`) without finalizing the upstream. The captions result-stream reader is unsubscribed **immediately** on disconnect (not deferred), so a dead client doesn't keep consuming/ACKing the shared consumer group for the whole grace window.
- **Heartbeats/idle timeout — none found at the application level.** No ping/pong interval, no idle-connection timeout, no max-session-duration constant anywhere in `stt-ws.gateway.ts` or `streaming.module.ts`; `apps/api/src/main.ts` registers `new WsAdapter(app)` with no options object. The only interval present, `socketHeartbeat` (20s, `:203-205`), is unrelated — it republishes this instance's open-socket count to a Redis registry for cross-instance platform metrics, not a client keepalive.

### 6f. Internal callback controller

`apps/api/src/modules/internal/stt-internal.controller.ts` — `@Controller('internal/stt')`, `@ApiSecurity('api-key')`, `@Authorize()`. Endpoints: `POST transcripts`, `PATCH jobs/:id/{start,progress,complete,fail}`, `GET jobs/:id/status`, `POST audio-records`, `POST media`. Auth is **not** the `X-Service-Token` shared-secret middleware documented for Python-service inbound auth — every handler manually asserts `request.apiKey` was populated by the global `UnifiedAuthGuard`'s API-key path (`ensureInternalApiKey()`, `:28-32`); the Python caller sends header `X-Internal-Service-Key`, accepted by the generic API-key extractor (`ApiKeyService.extractApiKeyFromRequest`) alongside `apikey`/`api-key`/`x-api-key`.

---

## 7. Audio Format Contract End-to-End

| Hop | Format / Rate | Evidence |
|---|---|---|
| `getUserMedia` (mic) | Browser default (no explicit `sampleRate`/`echoCancellation`/etc. requested by the real SDK path — see §1 critical finding) | `useArcaAudio.ts:99-101` |
| Shared `AudioContext` | Forced **48000 Hz** | `useArcaAudio.ts:103`, `useAudioMixer.ts:49` |
| RNNoise (worklet) | 48000 Hz, 480-sample (10ms) frames | `RNNoiseProcessor.ts:27,32` |
| Silero VAD | Internally 16000 Hz (resampled inside external `vad-web` worklet), 512-sample frames | `VADProcessor.ts` (§3) |
| STT capture worklet | Taps 48kHz context, coalesces to 80ms frames (client-configurable) | `stt-capture.worklet.ts:36` |
| Client-side resample to Whisper rate | 48000→16000 Hz via Kaiser-sinc `resampleSinc()` | `audioResampler.ts:17,230-248` |
| Browser→Gateway wire | **Binary Int16LE PCM**, mono, sent per-frame with no client batching interval (JSON+base64 alternative exists, unused) | `SttV2WebSocketClient.ts:355-363`, `StreamingBackendSTTProvider.ts:229-236` |
| Gateway→stt-v2 | Redis Stream `XADD`, raw bytes in a `data` field + `sr`/`enc`(hardcoded `pcm_s16le`)/`ch`(`1`)/`seq`/`final`/`ts` fields | `streamingAudioBridge.service.ts:232-267` |
| stt-v2 decode | `AudioEncoding.PCM_S16LE`/`PCM_F32LE`, raw bytes (not base64) | `schemas.py:20-24,83-121` |
| Gateway session-meta fallback rate | `DEFAULT_SAMPLE_RATE = 16000` (used only if session-meta lookup fails) | `stt-ws.gateway.ts:54` |
| stt-v2→Gateway results | Redis Stream `XADD` flat key-value fields (`type`,`status`/`text`,`start_time`,`end_time`,`is_final`,`stable_chars`,`utterance_index`,`speaker_*`,`word_timestamps_json`) | `streamingAudioBridge.service.ts:622-693` |
| Gateway→Browser results | JSON text frames, `seq`-tagged | `stt-ws.gateway.ts:687-698` |

**Cadence/batching at each hop:** client coalesces to **80ms** frames (worklet, configurable via `frameMs`) → sent to gateway **immediately, one XADD per frame, no gateway-side batching** → stt-v2's `IngestionConsumer` reads in batches of up to `count=100` but only *blocks* up to **5000ms** waiting for the first available entry (no artificial delay on already-available entries) → server emits **partial** hypotheses at `streaming_partial_interval_s` = **0.4s** (down from a legacy hardcoded 1.0s per TASK-471 AC-1; `apps/stt-v2/src/stt_v2/core/config/settings.py:520-532`), bounded by an `0.5`s minimum-buffered-audio floor and an `8.0`s `streaming_partial_window_s` decode-tail cap (`:511-518`) → **finalization** is VAD-silence-driven at `vad_silence_threshold_ms = 500` (hardware-profile default, `execution_profile.py`) or an optional pipeline-configured time-based force-cap — the `LocalAgreementPolicy` in `commit_policy.py` is a *separate*, pure text-stabilization layer (`stable_chars`) over already-emitted partials/finals and does **not** itself decide when to finalize → gateway relays results via `XREADGROUP BLOCK 500ms`.

**Where latency can accumulate:** the 5000ms `IngestionConsumer` BLOCK window is a *ceiling on how long a truly idle stream waits*, not added latency for active streams; the 500ms result-read BLOCK is likewise a ceiling, not a batching delay. The measurable, code-evidenced latency contributors are: the 80ms client-side coalescing window, the 0.4s partial-emit cadence, the 500ms VAD-silence finalize threshold, ASR inference time itself (the commit's own live scorecard cites `commit_latency_p50 = 7383ms` under single-box contention), and the 512KiB WS egress high-watermark (which only engages under backpressure).

---

## 8. Error/Drop Visibility (TASK-454, TASK-461, TASK-464)

**TASK-454 — Client Audio-Drop Visibility** (status: `Review — implemented, adversarially reviewed, merged`). Root defect: `SttV2WebSocketClient.sendAudioFrame()`'s `false`-on-drop return was already implemented (TASK-298 D-15) but **ignored** by every caller — dropped PCM never reached the durable transcript with no clinician-visible signal. Fix: `apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts` now registers `onBackpressureDrop` and exposes a per-connection `droppedFrameCount` (resets on reconnect) plus a session-sticky `audioLostThisSession` latch (survives reconnect, clears only on start/stop); a new `DegradedBanner` renders `role=status`/`aria-live=polite`. `StreamingBackendSTTProvider.ts` (`packages/stt`) now honors the boolean return and counts drops via `getDroppedFrameCount()`.

**TASK-461 — SDK Reconnect UX + Wire Contract** (status: `Review`). Two disconnect-relevant fixes on `SttV2WebSocketClient.ts`: (a) `onReconnect` previously fired only at attempt-**start**, never on success — added `onReconnected(cb)`, fired from `onopen` guarded by `wasReconnecting`, letting a "reconnecting" UI transition back to "streaming" (this is the `onReconnected`/`onReconnectedCb` code confirmed in §5c above); (b) `onReconnectFailed` previously left the mic track live and the gateway-side session un-DELETEd on terminal failure — now runs `releaseAudio()` → `closeStreamSession()` → `setStatus('error')`. Also added tolerant wire-payload coercion (`coerceIsFinal`, dual-cased fields — confirmed in §5c's `normalizeTranscript`).

**TASK-464 — SDK Provider Drop Surfacing** (status: `Review`, spun out from TASK-454's review). TASK-454 fixed only the admin-console *playground* hook; the real `@arcaai/vox` consultation path had no consumer for `StreamingBackendSTTProvider.getDroppedFrameCount()`. Full push chain implemented (confirmed against code in §5d):
```
StreamingBackendSTTProvider.onDrop(count)  →  STTProcessor.onBackpressureDrop(count)  →
TranscriptionPipeline emit 'audioDrop'  →  PluginManager.callbacks.onAudioDrop  →
useArcaAudio: store.markAudioLost() + store.incrementDroppedFrames()  →
store.audioLostThisSession / audioDroppedFrameCount  →  exported selectAudioDropped/selectAudioDegraded
```
This exactly matches the `onAudioDrop` callback wired in `useArcaAudio.ts:233-236` (`store.markAudioLost(); store.incrementDroppedFrames();`) read directly in §5. No production banner/toast was built for this path (ticket explicitly marked it optional).

**TASK-470/471 context** (both `Review`, live-verified against the 0040fe3e fix): TASK-470 is a streaming-quality eval harness (`medical_wer`, `keyterm_recall`/`keyphrase_recall`, `partial_revision_rate`, `commit_latency_p50/p99`, `audio_coverage_ratio`, `seq.gap_count`) against de-identified clinical fixtures at `apps/stt-v2/tests/e2e/fixtures/clinical/{cardiology_consult_01,discharge_summary_01,medication_review_01}.{gt.txt,keyterms.json}` — the matching `.wav` files (visible as untracked in `git status`) were intentionally not committed by the ticket itself and were added later for the live AC-4 re-run. TASK-471 is the "tentative-tail" partial-cadence change (§5e/§7); its remaining red scorecard metrics (`partial_revision_rate` 0.77-0.80 vs baseline ~0.02, `commit_latency_p50` 7383ms) are attributed to the deliberate cadence trade-off and single-box test contention, left for a product-owner decision — not the empty-final bug, which 0040fe3e fixed.

---

## Notable Weaknesses / Latency Hotspots / Tech Debt Observed

**Correctness / data-loss risk**
1. **Client-side stop-race that the 0040fe3e fix does not close.** The gateway fix ensures the Redis *reader* no longer completes on `finalizing` — but the production browser flow (`useArcaAudio.stopAudio()` → `StreamingBackendSTTProvider.stop()`→`destroy()`) sends `{"type":"stop"}` and then closes the WebSocket (`SttV2WebSocketClient.disconnect()`, synchronous `ws.close(1000,...)`) within the same `destroy()` call chain, **without waiting for any server acknowledgment**. `relayResult()` only sends to the client when `client.readyState === client.OPEN` (`stt-ws.gateway.ts:569`). Given ASR inference measurably lags the `finalize` control command (the commit's own scorecard: `commit_latency_p50 = 7383ms` under contention), the tail FINAL is very likely to arrive in Redis *after* the browser's socket has already closed in a normal "click stop" flow — the gateway's 15s resume-grace window only helps if the *same session reconnects*, which a simple stop-and-navigate-away flow never does. The commit's "verified LIVE" scorecard was run through the eval harness's own WS client, not through this production `useArcaAudio` teardown path, so it does not by itself demonstrate the production client reliably receives the tail final.
2. **Egress backpressure silently drops partials with no client-visible signal** (`stt-ws.gateway.ts:551-560`) — only final-transcript drops get an explicit `{type:'gap'}` marker; a dropped partial is invisible to the end user (though harmless to the durable transcript, since finals are re-derived independently).
3. **`SttV2WebSocketClient`'s documented disconnect-time audio queue (`maxQueueSize=200`, drop-oldest) does not exist in code** — audio captured while disconnected is silently dropped at `StreamingBackendSTTProvider.processAudio()`'s `isConnected()` guard, with no queuing or replay. The `maxQueueSize` config is dead.
4. **TASK-471's tentative-tail UI render path is likely unreachable via the SDK's own default wiring** — `StreamingBackendSTTProvider.normalizeTranscript()` drops `stableChars`/`resultType`/`utteranceIndex` when building `TranscriptionResult`, and `useArcaAudio`'s `onTranscription` only ever appends fully-`isFinal` segments to the store; the `currentTranscript` scalar used for the `interim` render has no `stableChars`. The two-tone settled/tentative render in `transcript-segment.tsx:178-184` is real and correct, but nothing inside this repo's default hook chain feeds it the data it needs.

**Latency hotspots**
5. **VAD model + ONNX Runtime WASM binaries fetch from a public CDN (`cdn.jsdelivr.net`) by default on every session**, not self-hosted or bundled — a network round-trip on the capture cold-start path, plus the version-mismatch risk the package's own changelog documents as a past incident (`constants.ts:14-18`).
6. **Local Whisper's `AudioBufferManager` has no cap** — if inference is slower than capture (weak hardware, large model), the input buffer grows unboundedly between the 500ms drain polls.
7. Two independent `MediaStreamAudioSourceNode`s are created from the same track on every `STTProcessor` attach (`STTProcessor.ts:215-219` + `audioCapture.ts:95`) — minor but avoidable Web Audio graph overhead.
8. A hardcoded **10000ms** timeout gates the RNNoise AudioWorklet init before falling back to the deprecated main-thread `ScriptProcessorNode` (`NoiseFilterProcessor.ts:189-191`) — a slow WASM instantiate can add up to 10s of dead time before audio starts flowing through *any* path.

**Inconsistency / tech debt**
9. Two divergent VAD negative-threshold formulas (`positive - 0.15` vs `positive * 0.7`) that only coincide at the default sensitivity (0.5); production `redemptionMs` is 500ms at the wired default vs. the package's own documented 1400ms default (2.8× apart) vs. a third, seemingly-dead 300ms default (`DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG` in `types/pipeline.ts`) that no live code path actually reaches.
10. `packages/vad`'s `FrameAccumulator`/`AudioRingBuffer`/`resampler.ts` module are exported public API but dead code with respect to the real-time path (real framing/resampling happens inside the external `@ricky0123/vad-web` dependency).
11. `packages/stt/src/websocket/WebSocketClient.ts` + `MessageHandler.ts` + `BackendSTTProvider`(`RemoteSTTProvider`) form a fully self-contained, `@deprecated`-tagged legacy protocol island (own reconnect backoff: max 3 attempts/1000ms base/30s cap vs. `SttV2WebSocketClient`'s 5 attempts — different tuning for the same conceptual concern) that is still shipped and reachable (when `pipelineId` is absent), carrying ongoing maintenance cost for a path the SDK's own comments call dead.
12. `WebSocketClient.ts` re-implements the float32→int16 PCM clamp inline instead of reusing `audioResampler.ts`'s `float32ToInt16` — duplicated conversion logic between the legacy and modern paths.
13. No application-level WS ping/pong or idle-connection timeout exists on `SttWsGateway` — disconnection detection relies entirely on TCP/opcode-level `close` events; a network black-hole (no clean close frame) would leave a `SessionInfo` (and its upstream stt-v2 session + Redis consumer-group reader) alive indefinitely with nothing to time it out beyond the passive resume-grace timer, which only arms on an observed `close`.
14. `packages/room`'s carefully-defaulted `buildAudioConstraints()`/`DEFAULT_AUDIO_OPTIONS` (explicit `echoCancellation`/`noiseSuppression`/`autoGainControl`/`channelCount`) is dead code on the actual `@arcaai/vox` capture entry point (`useArcaAudio.ts`), which calls `getUserMedia` with a bare `audio: true`/`{deviceId}` — the two capture paths (room's `AudioTrack.initialize()` vs. the SDK's `useArcaAudio.startAudio()`) have diverged in what they actually request from the browser.
15. `AudioMixer` performs no sample-rate/channel-count reconciliation between a primary and secondary microphone — two devices with different native rates are summed via GainNode with no explicit resampling, relying entirely on unstated Web Audio API implicit behavior.
