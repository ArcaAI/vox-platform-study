> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `explorer` `a0a4ea893101ccf6d` (sub-agent of 11). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Audio Capture Pipeline Research — `packages/room` + `packages/noise-filter`

## 1. getUserMedia constraints

**Defaults** — `packages/room/src/types/index.ts:51-57`:
```ts
export const DEFAULT_AUDIO_OPTIONS: Required<Omit<AudioCaptureOptions, 'deviceId' | 'sampleRate' | 'latency'>> = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  voiceIsolation: false,
  channelCount: 1,
};
```

**Constraint builder** — `packages/room/src/utils/constraints.ts:15-46` (`buildAudioConstraints`):
```ts
const merged = { ...DEFAULT_AUDIO_OPTIONS, ...options };
const constraints: MediaTrackConstraints = {
  echoCancellation: merged.echoCancellation,
  noiseSuppression: merged.noiseSuppression,
  autoGainControl: merged.autoGainControl,
  channelCount: merged.channelCount,
};
// deviceId only added if options.deviceId set → { exact: options.deviceId }  (constraints.ts:27)
// sampleRate only added if options.sampleRate set                            (constraints.ts:32)
// latency only added if options.latency set (experimental)                  (constraints.ts:37)
// voiceIsolation always added since merged.voiceIsolation defaults to false, not undefined (constraints.ts:41-43)
```
So the effective default object requested from `getUserMedia` is `{ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, voiceIsolation: false }` — **no `sampleRate` is forced by default** (browser picks its native rate unless caller passes one). Consumed in `AudioTrack.initialize()`: `navigator.mediaDevices.getUserMedia({ audio: constraints })` — `packages/room/src/core/AudioTrack.ts:141-145`.

**Configurable?** Yes — every field is overridable per-call via `AudioCaptureOptions` (`AudioTrack.initialize(options)` / `useAudioTrack(options)`); only the *defaults* are hardcoded in `DEFAULT_AUDIO_OPTIONS`.

**Browser-specific branching?** None in `constraints.ts` itself (no Safari/Chrome-conditional constraint values). Safari branching in this package is confined to two other concerns:
- iOS Safari suspended-`AudioContext` click/touch/keydown resume workaround — `packages/room/src/core/AudioContextManager.ts:367-370`, `:457-474`.
- AudioWorklet capability gating — `isSafariVersionSupported()` requires Safari ≥ 17.4: `packages/room/src/utils/browserSupport.ts:41-48` (`return (major ?? 0) > 17 || ((major ?? 0) === 17 && (minor ?? 0) >= 4);`), used by `isAdvancedAudioSupported()` at `browserSupport.ts:139-141`.

## 2. AudioContext creation

**Options passed** — `packages/room/src/core/AudioContextManager.ts:350-365` (`createAudioContext`):
```ts
const options: AudioContextOptions = {
  latencyHint: this.options.latencyHint ?? 'interactive',
};
if (this.options.sampleRate) {
  options.sampleRate = this.options.sampleRate;
}
const ctx = new AudioContextCtor(options);
```
Default `RoomOptions` — `packages/room/src/types/index.ts:157-160`: `DEFAULT_ROOM_OPTIONS = { webAudioMix: true, latencyHint: 'interactive' }` — **no default `sampleRate`**. Same pattern repeated in the standalone helper `getNewAudioContext()` — `AudioContextManager.ts:512-527`.

Two call sites in the codebase hardcode `sampleRate: 48000` when acquiring the shared singleton: `packages/room/src/hooks/useAudioMixer.ts:49` (`AudioContextManager.getInstance({ sampleRate: 48000 })`) and, outside the two focus packages, `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:103` (same call). Neither passes `requireSampleRate` for enforcement.

**AudioWorkletNode vs ScriptProcessorNode**: `packages/room` itself instantiates **neither** — grep of `packages/room/src` for `AudioWorkletNode|ScriptProcessorNode|createScriptProcessor` returns zero hits outside `browserSupport.ts` (feature-detection only) and `utils/workletLoader.ts:68` (generic `audioContext.audioWorklet.addModule(url)` factory, not self-invoked). All actual DSP nodes live in `packages/noise-filter`:
- **AudioWorkletNode** (primary path) — `createRNNoiseWorkletNode()`: `return new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: {} });` — `packages/noise-filter/src/worklets/worklet-loader.ts:279-284`. Invoked from `packages/noise-filter/src/processors/NoiseFilterProcessor.ts:158`.
- **ScriptProcessorNode** (deprecated fallback, only on AudioWorklet init failure) — `this.fallbackScriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);` — `packages/noise-filter/src/processors/NoiseFilterProcessor.ts:258` (buffer size **4096**, 1 input channel, 1 output channel).

**Worklet processor name/source**: `'rnnoise-worklet-processor'` (`WORKLET_PROCESSOR_NAME`, `packages/noise-filter/src/worklets/worklet-loader.ts:14`), registered via `registerProcessor('rnnoise-worklet-processor', RNNoiseWorkletProcessor);` in **two places that must stay in sync**:
- `packages/noise-filter/src/worklets/rnnoise.worklet.ts:267` — the canonical TS source, compiled to `dist/worklets/rnnoise.worklet.js` for consumers who load it via `addModule()` directly.
- `packages/noise-filter/src/worklets/worklet-loader.ts:30-227` (inline template-string mirror) — this is the version actually blob-URL'd and registered at runtime by `registerRNNoiseWorklet()` (`worklet-loader.ts:241-257`), via the shared `packages/room/src/utils/workletLoader.ts` factory (`createWorkletLoader`, blob-cache + `addModule`, `workletLoader.ts:42-83`). File header explicitly warns these two copies must be kept "algorithmically identical" (`worklet-loader.ts:19-28`).

`createWorkletLoader` (room) is also consumed by `packages/stt/src/worklets/stt-capture.worklet.ts` (outside scope) — confirming it's a shared cross-package pattern, not room-specific DSP.

## 3. AudioTrack class

`packages/room/src/core/AudioTrack.ts:91` — `export class AudioTrack extends TypedEventEmitter<TrackEventMap>` (EventEmitter3-backed, `packages/room/src/events/EventEmitter.ts:46-50`).

**Lifecycle**: `initialize(options?)` (`:132-173`, calls `getUserMedia`) → state `IDLE/ENDED → INITIALIZING → ACTIVE`; `initializeFromTrack(track)` (`:180-197`, wraps an existing `MediaStreamTrack`); `restart(options?)` (`:517-529`, stop+initialize+reattach processor); `stop()` (`:539-546`, idempotent guard on `TrackState.ENDED`); private `teardownInternal({stopSourceTrack})` (`:559-599`) shared by `stop()` and `handleTrackEnded()` (`:616-626`, fires when the OS reports device loss — emits `Ended` synchronously, tears down async as a fire-and-forget tail).

**Processor management** (mutex-guarded by an internal `AsyncLock`, `:19-44`): `setProcessor(processor)` (`:281-324`) builds `AudioProcessorOptions{kind:'audio', track: this.sourceTrack, audioContext: this.audioContext}` and calls `processor.init(...)`; `stopProcessor()` (`:329-337`); `getProcessor()`, `hasProcessor()`.

**Feature toggles**: `setFeature(feature, enabled)` (`:394-403`) → `applyFeatureConstraint` (`track.applyConstraints()`); `getFeatures()`, `isFeatureEnabled()`, `getSettings()`.

**Level metering**: `setupAudioLevelMonitoring()` (`:441-465`) — `AnalyserNode.fftSize = 2048` (`:447`), pre-allocated `Float32Array(2048)` reused every tick (`:450`, explicitly to avoid per-frame GC per the W1-6 comment), `setInterval` at `options.audioLevelInterval ?? 50` ms (`:458`); `updateAudioLevel()` (`:473-499`) computes RMS/peak via `calculateRMSLevel`/`calculatePeakLevel`, smooths with `createSmoothingCalculator(0.8)` (`:104`), emits `TrackEvent.AudioLevelUpdate`.

**How raw audio flows out** — two distinct, non-overlapping channels:
1. **`mediaStreamTrack` getter** (`:203-205`): `return this.currentProcessor?.processedTrack ?? this.sourceTrack;` — the actual PCM-bearing `MediaStreamTrack` (processed if a processor is attached, else raw mic track). This is the *only* way raw/processed audio samples leave `AudioTrack` — it's a live WebRTC track reference plugged into a Web Audio graph or another consumer's `MediaStream`, **not** a callback, event, or `ReadableStream` of samples.
2. **Event emitter** (`TrackEvent` enum, `packages/room/src/events/TrackEvents.ts:17-36`: `Muted, Unmuted, Ended, Restarted, ProcessorUpdate, FeatureUpdate, AudioLevelUpdate, SilenceDetected, Error`) — carries only derived metadata (mute state, processor swaps, `{level, isSpeaking, peak, average}`), never raw sample data.

## 4. AudioMixer — secondary device mixing

`packages/room/src/core/AudioMixer.ts:28-30` (class doc, verbatim): *"Uses GainNode summation (NOT ChannelMergerNode) per W3C spec — multiple connect() calls to the same node auto-sum the signals. Master gain uses 1/sqrt(N) normalization to prevent clipping."*

**Algorithm** — `addSource(id, stream, gain = 1.0)` (`:57-72`): `sourceNode = audioContext.createMediaStreamSource(stream)` → per-source `gainNode = audioContext.createGain(); gainNode.gain.setValueAtTime(gain, audioContext.currentTime)` → `sourceNode.connect(gainNode); gainNode.connect(this.masterGain)`. All gain nodes feed the single `masterGain` (auto-summed), which connects to one `MediaStreamAudioDestinationNode` (`:53-54`).

**Normalization** — `updateMasterGain()` (`:145-149`):
```ts
const activeCount = this.getActiveSourceCount();
const normalizedGain = activeCount > 0 ? 1.0 / Math.sqrt(activeCount) : 1.0;
this.masterGain.gain.setValueAtTime(normalizedGain, this.audioContext.currentTime);
```
With 2 active sources this evaluates to `1/√2 ≈ 0.7071`.

**Sample-rate / channel-count mismatch handling: NOT HANDLED.** `AudioMixer.ts` contains zero references to `sampleRate` or `channelCount` (confirmed by full-file read + grep). Each source's `MediaStreamAudioSourceNode` is simply wired into the one shared `AudioContext`; whatever implicit up/down-sampling and channel up/down-mixing the browser performs per the Web Audio API spec (default `channelCountMode`/`channelInterpretation`) is the *only* mitigation — there is no explicit validation, warning, or resampling code, and `packages/room/src/__tests__/AudioMixer.test.ts` has zero assertions on `sampleRate`/`channelCount` either (grep confirmed no matches).

**Real dual-mic call site** (outside the two focus packages, but this is where `secondaryDeviceId` actually reaches `AudioMixer`) — `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts:99-132`:
```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: options?.deviceId ? { deviceId: { exact: options.deviceId } } : true,
});
const ctxManager = AudioContextManager.getInstance({ sampleRate: 48000 });
const audioContext = await ctxManager.acquire();
...
if (options?.secondaryDeviceId) {
  const secondaryStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: options.secondaryDeviceId } },
  });
  const mixer = new AudioMixer(audioContext);
  mixer.addSource('primary', stream);
  mixer.addSource('secondary', secondaryStream);
  const mixedTrack = mixer.getMixedTrack();
  if (mixedTrack) track = mixedTrack;
}
```
Neither `getUserMedia` call requests an explicit `sampleRate`/`channelCount` for either device — each device's native track is connected as-is into the 48 kHz-forced context, with no mismatch handling at any layer.

## 5. Resampling in `packages/room`

`resampleAudio(samples, fromSampleRate, toSampleRate)` — **linear interpolation** — `packages/room/src/utils/audioUtils.ts:137-156`:
```ts
if (fromSampleRate === toSampleRate) return samples;
const ratio = fromSampleRate / toSampleRate;
const newLength = Math.round(samples.length / ratio);
const result = new Float32Array(newLength);
for (let i = 0; i < newLength; i++) {
  const srcIndex = i * ratio;
  const srcIndexFloor = Math.floor(srcIndex);
  const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
  const fraction = srcIndex - srcIndexFloor;
  result[i] = samples[srcIndexFloor]! * (1 - fraction) + samples[srcIndexCeil]! * fraction;
}
```
**This function is never called anywhere inside `packages/room/src` or `packages/noise-filter/src`** (verified by repo-wide grep of `resampleAudio(` call sites, excluding its own definition/tests/dist). It is exported from the barrel as a utility but only *actually consumed* by sibling packages outside this task's scope: `packages/vad/src/utils/resampler.ts:25,72` and `packages/stt/src/utils/audioResampler.ts:260`. No `OfflineAudioContext`-based resampler exists anywhere in either focus package.

## 6. Frame/chunk sizes

The Web-Audio-spec **128-sample render quantum is never overridden** anywhere in `packages/room` or `packages/noise-filter` — no code sets a custom quantum (not possible via public API at time of writing); the only in-repo reference is a comment, `packages/noise-filter/src/processors/RNNoiseProcessor.ts:57`: `// Frame accumulation buffer (per-call render quantum → 480-sample frames).`

**Batching to 480 samples** happens explicitly via an accumulator, identically in both the worklet-thread and main-thread-fallback implementations:
- Worklet (`packages/noise-filter/src/worklets/rnnoise.worklet.ts:173-178`): `this.inputBuffer[this.inputBufferIndex++] = input[i]!; if (this.inputBufferIndex >= RNNOISE_FRAME_SIZE) { this.processRNNoiseFrame(); this.inputBufferIndex = 0; }` — `input`/`output` here are the raw 128-sample arrays handed to `process()` by the browser each render quantum.
- Main-thread fallback (`packages/noise-filter/src/processors/RNNoiseProcessor.ts:141-147`) — identical accumulate-then-flush pattern, fed by the 4096-sample `ScriptProcessorNode` buffers instead of 128-sample quanta.

`RNNOISE_FRAME_SIZE = 480` is declared independently in three places that must stay numerically synced: exported const `packages/noise-filter/src/processors/RNNoiseProcessor.ts:27`; local const `packages/noise-filter/src/worklets/rnnoise.worklet.ts:25`; and inside the inline blob-string template `packages/noise-filter/src/worklets/worklet-loader.ts:31`.

**ScriptProcessorNode fallback chunk size**: 4096 samples — `createScriptProcessor(4096, 1, 1)`, `packages/noise-filter/src/processors/NoiseFilterProcessor.ts:258`.

**AudioTrack level meter** uses `AnalyserNode.fftSize = 2048` (`packages/room/src/core/AudioTrack.ts:447`) polled on a `setInterval` (default 50 ms) — a snapshot poll, not a queued frame pipeline; unrelated to the render-quantum/frame-size discussion above.

## 7. Backpressure

**Only explicit bounded queue with a drop policy** is the RNNoise output ring buffer (in `noise-filter`, not `room`):

- **Capacity**: `outputRingCapacity = RNNOISE_FRAME_SIZE * 2` = **960 samples** — declared identically at `packages/noise-filter/src/processors/RNNoiseProcessor.ts:64` and `packages/noise-filter/src/worklets/rnnoise.worklet.ts:65` (and mirrored in the blob string, `worklet-loader.ts:52`).
- **Policy: drop-oldest.** `packages/noise-filter/src/processors/RNNoiseProcessor.ts:183-189` (identical logic at `rnnoise.worklet.ts:206-210`):
```ts
if (this.outputRingSize >= this.outputRingCapacity) {
  // Ring overflow: consumer fell behind. Drop oldest sample to keep
  // the head moving and increment the dropped-frame counter.
  this.outputRingRead = (this.outputRingRead + 1) % this.outputRingCapacity;
  this.outputRingSize--;
  this.framesDropped++;
}
```
This ring only absorbs the **one-frame priming latency** between "accumulate 480 samples, then produce 480 processed samples in one shot" and "emit 1 sample per input sample continuously" — it is a local rate-smoothing buffer, not a cross-thread backpressure signal. On drop it silently increments `framesDropped` (surfaced only via polled `NoiseFilterStats.framesDropped`, e.g. `getStats()` at `RNNoiseProcessor.ts:207-222`); no message/event is pushed to the main thread at the moment of drop.

**Nowhere in `packages/room/src`** (`AudioTrack`/`AudioMixer`/`Room`/`ProcessorPipeline`) is there any queue, ring buffer, max-size bound, or explicit backpressure signaling — confirmed by grep for `ring ?buffer|backpressure|drop-oldest|dropoldest|maxqueue` returning zero hits outside `__tests__`. If a downstream consumer is slower than capture, `packages/room` provides no protective mechanism at all; the live `MediaStreamTrack`/Web Audio graph just keeps flowing (any glitching from an overloaded consumer would occur at the browser's native audio-thread level, outside this codebase).

## 8. ProcessorPipeline ordering

Order is **config-driven via a `priority` number per processor, not hardcoded**.

- `add(processor, options: { priority?: number; enabled?: boolean } = {})` — `packages/room/src/core/ProcessorPipeline.ts:64-73`: stores `{ processor, enabled: options.enabled ?? true, priority: options.priority ?? this.processors.length * 10 }`, then calls `sortProcessors()`.
- `sortProcessors()` — `:227-229`: `this.processors.sort((a, b) => a.priority - b.priority);` (ascending — lower number runs earlier).
- Constructor — `:46-56` — accepts an initial array and assigns `options.priority ?? index * 10` per entry when not explicit.
- Execution — `buildPipeline()` (`:168-196`) iterates `getEnabledProcessors()` (already filtered+sorted) in a plain `for...of`, threading each processor's `processedTrack` as the next processor's input `track`; zero enabled processors → pure pass-through of the original track (`:171-175`).

Nothing in `ProcessorPipeline.ts` hardcodes a specific ordering (e.g., "noise-filter before VAD") — the class doc's own example (`:20-23`) shows the caller choosing priorities (`vadProcessor` @ 10, `noiseFilterProcessor` @ 5 "runs first"). The actual production instantiation of a multi-processor pipeline (`new ProcessorPipeline(...)`) occurs in `packages/room/src/hooks/useProcessors.ts:90,131` (a generic React hook, order still caller-supplied) — I did not find a hardcoded production pipeline construction inside either focus package; that orchestration (if any) lives in `packages/agentic-sdk-v2`'s `PluginManager`/`TranscriptionPipeline`, outside the requested scope.

## 9. Where RNNoise sits in the audio chain

`AudioTrack`/`Room` have **no knowledge of RNNoise** — the coupling is entirely through the generic `TrackProcessor` plugin contract (`packages/room/src/processors/types.ts:69-138`). `NoiseFilterProcessor extends BaseProcessor` (`packages/room` export) and is attached via `AudioTrack.setProcessor(processor)`.

`AudioTrack.setProcessor()` (`packages/room/src/core/AudioTrack.ts:301-307`) builds:
```ts
const processorOptions: AudioProcessorOptions = { kind: 'audio', track: this.sourceTrack, audioContext: this.audioContext };
await processor.init(processorOptions);
```
— i.e. `NoiseFilterProcessor.onInit()` (`packages/noise-filter/src/processors/NoiseFilterProcessor.ts:102-145`) receives the **raw, unprocessed mic `MediaStreamTrack`** (`this.sourceTrack`) plus the shared `AudioContext`, and builds its own mini WebAudio subgraph:
```
sourceNode = audioContext.createMediaStreamSource(new MediaStream([track]))   (:124-125)
   → workletNode (RNNoise AudioWorkletNode, real graph node)                  (:158, :169)
   → destinationNode = audioContext.createMediaStreamDestination()            (:127-128, :170)
this.processedTrack = destinationNode.stream.getAudioTracks()[0]              (:139)
```
That `processedTrack` is exactly what `AudioTrack.mediaStreamTrack` (§3) subsequently returns to the rest of the app. So the full chain is: `getUserMedia → AudioTrack.sourceTrack → [NoiseFilterProcessor subgraph: MediaStreamAudioSourceNode → RNNoise AudioWorkletNode → MediaStreamAudioDestinationNode] → AudioTrack.currentProcessor.processedTrack → downstream (VAD/STT/etc.)`. Confirms RNNoise is a genuine live node spliced into the WebAudio graph, not an offline/batch transform.

## 10. RNNoise frame size (exact)

`export const RNNOISE_FRAME_SIZE = 480;` — `packages/noise-filter/src/processors/RNNoiseProcessor.ts:27` (doc comment `:24-26`: "Frame size expected by RNNoise (480 samples = 10ms at 48kHz)"). Duplicated as local `const RNNOISE_FRAME_SIZE = 480;` at `packages/noise-filter/src/worklets/rnnoise.worklet.ts:25` and again inside the inline runtime blob string at `packages/noise-filter/src/worklets/worklet-loader.ts:31`. All three read **480** — confirms the classic RNNoise framing exactly, no deviation.

## 11. Sample-rate handling / forcing

`RNNOISE_SAMPLE_RATE = 48000` — `packages/noise-filter/src/processors/RNNoiseProcessor.ts:32` (doc `:29-31`: "Sample rate expected by RNNoise"). **This constant is used only for a stats/latency display calculation**, not as a runtime guard: `getStats()` — `const frameDurationMs = (RNNOISE_FRAME_SIZE / RNNOISE_SAMPLE_RATE) * 1000;` (`RNNoiseProcessor.ts:209`); the worklet computes the equivalent using the AudioWorkletGlobalScope's actual `sampleRate` global instead (`rnnoise.worklet.ts:221`: `const frameDurationMs = (RNNOISE_FRAME_SIZE / sampleRate) * 1000;`) — i.e. the two "sample rate" values (a hardcoded 48000 constant on the main thread vs. the live worklet-thread `sampleRate`) are **not the same source of truth**, and neither is compared against the other.

`NoiseFilterOptions.sampleRate` defaults to `48000` — `DEFAULT_NOISE_FILTER_OPTIONS.sampleRate = 48000` (`packages/noise-filter/src/types/index.ts:105`, doc `:66-70`: "RNNoise is optimized for 48kHz. @default 48000") — but grep of every `this.options.` reference in `NoiseFilterProcessor.ts` shows this field is **only read once**, inside the debug-log dump (`NoiseFilterProcessor.ts:112`, `sampleRate: this.options.sampleRate`). **No code path in `NoiseFilterProcessor`/`RNNoiseProcessor` validates the live `AudioContext.sampleRate` against 48000, and neither performs any internal resampling.**

The only enforcement mechanism in the whole audio stack lives one layer up, opt-in, in `@arcaai/room`'s `AudioContextManager`:
```
packages/room/src/core/AudioContextManager.ts:14-19 (doc, verbatim):
"Downstream processors hard-code the audio sample rate they were designed
for (RNNoise → 48 000 Hz; Silero VAD → 16 000 Hz with internal resampling).
If the host AudioContext runs at a different rate, those processors
silently degrade in quality. Use these options to opt into a strict
(throw) or warn-only enforcement at acquire-time."
```
```ts
// AudioContextManager.ts:189-204 (enforceSampleRate)
if (opts.requireSampleRate === undefined) return;        // no-op unless caller opts in
if (ctx.sampleRate === opts.requireSampleRate) return;
const message = `AudioContext sampleRate is ${ctx.sampleRate} Hz but the caller required ${opts.requireSampleRate} Hz. ...`;
if (opts.allowMismatch) { console.warn(...); return; }
throw new RoomSampleRateMismatchError(message);
```
Repo-wide grep of `requireSampleRate` shows it is used **only inside `packages/room/src/core/AudioContextManager.ts` and `RoomErrors.ts`** — no consumer (`NoiseFilterProcessor`, `useNoiseFilter`, `useArcaAudio`, `useAudioMixer`) ever calls `acquire({ requireSampleRate: 48000 })`. Practical implication: if the shared `AudioContext` is ever created at a non-48kHz rate and no caller opts into `requireSampleRate`, RNNoise will silently run its 480-sample framing against the wrong wall-clock window (e.g. at 44100 Hz, 480 samples ≈ 10.88 ms instead of the model's trained 10 ms) with **zero error or warning** anywhere in the pipeline.

## 12. Bypass conditions (exact code)

**Top-level support check** — `NoiseFilterProcessor.isSupported()`, `packages/noise-filter/src/processors/NoiseFilterProcessor.ts:94-97`:
```ts
isSupported(): boolean {
  const support = getNoiseFilterBrowserSupport();
  return support.rnnoiseSupported || support.nativeFallbackAvailable;
}
```

**Hard failure** (throws, no audio processing at all) — `onInit()`, `NoiseFilterProcessor.ts:119-121`:
```ts
if (!support.rnnoiseSupported && !support.nativeFallbackAvailable) {
  throw new NoiseFilterError(NoiseFilterErrorCode.NOT_SUPPORTED, support.unsupportedReason ?? 'Noise filter not supported');
}
```

**RNNoise WASM-path gate** — `isRNNoiseSupported()`, `packages/noise-filter/src/utils/browserSupport.ts:98-104`:
```ts
export function isRNNoiseSupported(): boolean {
  const hasWasm = isWebAssemblySupported();
  const hasAudioContext = isAudioContextSupported();
  const hasWorkletOrFallback = isAudioWorkletSupported() || isScriptProcessorSupported();
  return hasWasm && hasAudioContext && hasWorkletOrFallback;
}
```
Note: **`crossOriginIsolated` / `SharedArrayBuffer` do NOT gate RNNoise.** `isSharedArrayBufferSupported()` is computed and exposed on `NoiseFilterBrowserSupport.sharedArrayBuffer` (`browserSupport.ts:112`, `getNoiseFilterBrowserSupport()` at `:109-139`) but is never AND'ed into `rnnoiseSupported` (`:117`: `const rnnoiseSupported = webAssembly && audioContext && (audioWorklet || scriptProcessor);` — no SAB term). Repo-wide grep confirms `crossOriginIsolated` **does not appear anywhere in `packages/room` or `packages/noise-filter`** — it's used only in the sibling `packages/vad/src/processors/VADProcessor.ts:41` and `packages/stt/src/workers/whisper.worker.ts:100` to gate ONNX Runtime `numThreads` for multi-threaded WASM, an unrelated concern (RNNoise here is single-threaded WASM).

**Runtime path selection (noiseCancellation-disabled or unsupported → pure native pass-through, no RNNoise)** — `onInit()`, `NoiseFilterProcessor.ts:130-136`:
```ts
if (isRNNoiseSupported() && this.options.noiseCancellation) {
  await this.initWorkletProcessing(audioContext);
} else {
  this.initNativeFallback();   // just sourceNode.connect(destinationNode) — no RNNoise at all
}
```

**AudioWorklet → ScriptProcessor runtime fallback** (RNNoise still runs, just on main thread) — `initWorkletProcessing()` catch, `NoiseFilterProcessor.ts:150-177`:
```ts
} catch (error) {
  console.warn('Failed to initialize AudioWorklet, falling back to ScriptProcessor:', error);
  this.initScriptProcessorFallback();
}
```
Triggered by any failure in `registerRNNoiseWorklet()`, worklet-node construction, or `initWorkletRNNoise()` — including a **hardcoded 10000 ms init timeout**: `packages/noise-filter/src/processors/NoiseFilterProcessor.ts:189-191`:
```ts
const timeout = setTimeout(() => {
  reject(new Error('Worklet initialization timeout'));
}, 10000);
```

**Safari-specific gating** — `isSafariAudioWorkletSupported()` = `isSafariVersionSupported() && isSafari()` (`packages/noise-filter/src/utils/browserSupport.ts:91-93`), composing room's Safari-17.4+ check (§1); on older Safari this steers `hasWorkletOrFallback` in `isRNNoiseSupported()` down the `isScriptProcessorSupported()` branch.

## 13. AudioWorkletProcessor confirmation

`class RNNoiseWorkletProcessor extends AudioWorkletProcessor { ... }` — `packages/noise-filter/src/worklets/rnnoise.worklet.ts:44` (structurally identical inline class in the runtime blob string, `worklet-loader.ts:34`). Registered with the global `registerProcessor('rnnoise-worklet-processor', RNNoiseWorkletProcessor);` (`rnnoise.worklet.ts:267`, `worklet-loader.ts:226`) — an API that only exists inside `AudioWorkletGlobalScope`, confirming it executes on the browser's dedicated real-time audio rendering thread, not the main JS thread. File header states this directly: *"AudioWorklet processor for real-time noise cancellation using RNNoise. This runs in a separate thread for low-latency audio processing."* (`rnnoise.worklet.ts:3-5`).

**Implications**:
- The per-128-sample-quantum `process()` callback (`rnnoise.worklet.ts:153-191`) executing the WASM `rnnoise_process_frame` call runs **off the main thread**, so it cannot be blocked by (nor does it block) main-thread/UI JS work.
- Conversely, this shifts the risk to the real-time audio thread itself: any stall inside `process()`/WASM causes audio underruns/glitches, a different failure class than "main thread jank." The only in-repo instrumentation of this risk is a `performance.now()`-timed `processingTimeSum` (`rnnoise.worklet.ts:171,189`) surfaced as `NoiseFilterStats.cpuLoad = Math.min(1, avgProcessingTime / frameDurationMs)` (`sendStats()`, `rnnoise.worklet.ts:219-236`).
- The **fallback path is explicitly NOT a worklet**: `RNNoiseProcessor` (`packages/noise-filter/src/processors/RNNoiseProcessor.ts`) is a plain class with no `AudioWorkletProcessor` base, driven by a **main-thread** `ScriptProcessorNode.onaudioprocess` callback (`NoiseFilterProcessor.ts:260-269`) — so in fallback mode, main-thread jank *can* cause audio glitches, which is precisely the well-known drawback that makes `ScriptProcessorNode` deprecated in favor of `AudioWorkletNode`.

---

### Key files read (absolute paths)
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/room/src/core/{AudioContextManager,AudioTrack,AudioMixer,Room,ProcessorPipeline}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/room/src/utils/{constraints,audioUtils,workletLoader,browserSupport,debugLogger}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/room/src/processors/{BaseProcessor,BaseTextProcessor,NativeProcessor,types}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/room/src/hooks/{useAudioTrack,useAudioMixer,useAudioLevel,useDevices,useProcessors}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/room/src/events/{TrackEvents,EventEmitter}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/room/src/types/index.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/noise-filter/src/processors/{NoiseFilterProcessor,RNNoiseProcessor,rnnoiseModule,workletRnnoiseLoader}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/noise-filter/src/worklets/{rnnoise.worklet,worklet-loader}.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/noise-filter/src/hooks/useNoiseFilter.ts`
- `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/noise-filter/src/{wasmAsset,types/index,utils/browserSupport}.ts`
- Supporting context (outside the two focus packages, cited where directly relevant to Q4/Q5/Q11/Q12): `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts`, `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/vad/src/{utils/resampler.ts,processors/VADProcessor.ts}`, `/Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt/src/{utils/audioResampler.ts,workers/whisper.worker.ts}`
