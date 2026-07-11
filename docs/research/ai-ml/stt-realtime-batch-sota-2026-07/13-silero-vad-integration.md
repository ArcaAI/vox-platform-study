> **Research artifact — STT Realtime + Batch SOTA Assessment (2026-07).** Codebase map / spot check (read-only, repo state of 2026-07-10, branch `fix/2605-review`).
> Agent: `explorer` `aadc02b0ef52706f5` (sub-agent of 11). Final report captured verbatim (process narration removed).
> Synthesis: [stt-realtime-batch-sota-assessment-2026-07.md](../stt-realtime-batch-sota-assessment-2026-07.md) · Fleet index: [README.md](./README.md)

# Silero VAD Integration Map — `packages/vad` + SDK Wiring

## 1. Silero VAD model version, asset filename, load origin

- **Version: Silero VAD v5 is the default and the only actively-wired model.** `VADModel = 'v5' | 'legacy'` (`packages/vad/src/types/index.ts:16`). `DEFAULT_VAD_OPTIONS.model: 'v5'` (`packages/vad/src/types/index.ts:143`). Package-level doc: "Uses Silero VAD v5 via @ricky0123/vad-web for accurate speech detection." (`packages/vad/src/processors/VADProcessor.ts:5`).
- **'legacy' option exists** (maps to Silero v4-generation, 1536-sample frame) but is only auto-selected for Safari-without-AudioWorklet or iOS: `getRecommendedModel()` (`packages/vad/src/utils/browserSupport.ts:127-137`).
- **Model asset filename: NOT vendored in the repo.** `find` under `packages/vad/` for `*.onnx` returned zero results — confirmed empty. The actual `.onnx` filenames only exist inside the external npm dependency `@ricky0123/vad-web@0.0.30`'s own `dist/` folder (verified by reading `node_modules/.pnpm/@ricky0123+vad-web@0.0.30/node_modules/@ricky0123/vad-web/dist/`, which contains `silero_vad_v5.onnx` and `silero_vad_legacy.onnx` — informational, not part of this repo's source tree).
- **Load origin: CDN by default**, self-hostable via override. `DEFAULT_BASE_ASSET_PATH = `https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist/`` (`packages/vad/src/constants.ts:40`), interpolating `VAD_WEB_VERSION = '0.0.30'` (`packages/vad/src/constants.ts:25`). `VADProcessor` passes `baseAssetPath: this.options.baseAssetPath ?? DEFAULT_BASE_ASSET_PATH` into `vad-web`'s `RealTimeVADOptions` (`packages/vad/src/processors/VADProcessor.ts:293`). Doc comment: "Prefer self-hosting these assets in production; supply `baseAssetPath` via `VADOptions` to override." (`packages/vad/src/constants.ts:37-38`).
- Neither `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`'s `createVAD(...)` call (`TranscriptionPipeline.ts:145-151`) nor `packages/agentic-sdk-v2/src/core/PluginManager.ts` override `baseAssetPath` — production wiring uses the CDN default unless an app-level consumer supplies one.

## 2. ONNX Runtime specifics

- **Package**: `onnxruntime-web`, pinned as a **devDependency** (not a runtime `dependencies` entry) at exactly `"onnxruntime-web": "1.27.0"` (`packages/vad/package.json:77`), mirrored by `ORT_WEB_VERSION = '1.27.0'` (`packages/vad/src/constants.ts:31`), used to build `DEFAULT_ONNX_WASM_BASE_PATH = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_WEB_VERSION}/dist/`` (`packages/vad/src/constants.ts:49`). Cross-check (informational, from `node_modules`): the actual `@ricky0123/vad-web@0.0.30` dependency declares `"onnxruntime-web": "^1.17.0"` — the repo forces a newer pinned build (1.27.0) via the CDN path override rather than whatever vad-web nominally resolves. The `constants.ts` header explicitly documents a past incident from this kind of mismatch: "Previously the default CDN paths pointed at `vad-web@0.0.29` and `onnxruntime-web@1.22.0` while the installed packages were `^0.0.30` and `^1.24.3`. The ONNX Runtime WASM ABI is not stable across minor versions, which made inference silently fail in self-hosted defaults." (`packages/vad/src/constants.ts:14-18`).
- **Backend/execution provider**: **no explicit backend string is set anywhere in `packages/vad/src`.** `grep` for `simd|webgl|webgpu|executionProvider|backend` (case-insensitive) across `packages/vad/src` returned **zero matches**. The code only ever touches `ort.env.wasm.numThreads` (`packages/vad/src/processors/VADProcessor.ts:53-57`), so the execution provider is implicitly WASM by virtue of only configuring the `.wasm` env namespace — never explicitly declared as a literal `'wasm'` string in this package.
- **SIMD**: not explicitly configured anywhere in `packages/vad/src` (same grep found no `simd` occurrences) — left at `onnxruntime-web`'s own default, not overridden by this codebase.
- **Multi-threading / `numThreads`**: computed by `resolveOrtNumThreads()` (`packages/vad/src/processors/VADProcessor.ts:40-46`):
  ```
  const MAX_VAD_ORT_THREADS = 8;                                    // VADProcessor.ts:39
  function resolveOrtNumThreads(): number {
    const isolated = (globalThis as {...}).crossOriginIsolated === true;  // VADProcessor.ts:41
    if (!isolated) return 1;                                        // VADProcessor.ts:42
    const hwConcurrency = (globalThis as {...}).navigator?.hardwareConcurrency; // VADProcessor.ts:43
    if (typeof hwConcurrency !== 'number' || !Number.isFinite(hwConcurrency) || hwConcurrency < 2) return 1; // VADProcessor.ts:44
    return Math.min(MAX_VAD_ORT_THREADS, Math.floor(hwConcurrency)); // VADProcessor.ts:45
  }
  ```
  i.e. **`numThreads = min(8, navigator.hardwareConcurrency)`** when cross-origin-isolated with `hardwareConcurrency >= 2`, else **`numThreads = 1`**.
- **`crossOriginIsolated` gate**: yes, explicit — `const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;` (`packages/vad/src/processors/VADProcessor.ts:41`). Applied via `configureOrtThreads()` (`VADProcessor.ts:53-57`), which reads the page-global `ort.env.wasm.numThreads` (vad-web bundles its own ORT instance — the comment notes "We avoid hard-importing `onnxruntime-web` here because vad-web manages the runtime instance," `VADProcessor.ts:50-51`) and is invoked at the top of `initMicVAD()` (`VADProcessor.ts:276`) before every `MicVAD.new()` call, with an accompanying comment: "Without isolation we leave the default (1) intact — promoting it crashes ORT immediately. We clamp to 8 because Silero VAD sees no benefit past that..." (`VADProcessor.ts:273-275`).
- A second, independent `crossOriginIsolated` check exists for **feature-detection/telemetry only** (not threading control): `isCrossOriginIsolated()` (`packages/vad/src/utils/browserSupport.ts:60-68`) and `isMultiThreadedONNXSupported()` (`browserSupport.ts:185-187`, requires WASM + `SharedArrayBuffer` + cross-origin-isolation).

## 3. Threshold constants — exact values

All in `DEFAULT_VAD_OPTIONS` (`packages/vad/src/types/index.ts:142-155`):

| Variable (exact name) | Value | Citation |
|---|---|---|
| `positiveSpeechThreshold` | `0.5` | `packages/vad/src/types/index.ts:144` |
| `negativeSpeechThreshold` | `0.35` | `packages/vad/src/types/index.ts:145` |
| `preSpeechPadMs` | `300` | `packages/vad/src/types/index.ts:146` |
| `postSpeechPadMs` | `300` | `packages/vad/src/types/index.ts:147` |
| `minSpeechMs` | `250` | `packages/vad/src/types/index.ts:148` |
| `redemptionMs` | `1400` | `packages/vad/src/types/index.ts:149` |
| `sampleRate` | `16000` | `packages/vad/src/types/index.ts:150` |
| `enableStats` | `false` | `packages/vad/src/types/index.ts:151` |
| `statsInterval` | `1000` | `packages/vad/src/types/index.ts:152` |
| `submitUserSpeechOnPause` | `false` | `packages/vad/src/types/index.ts:153` |
| `silenceResetMs` | `5000` | `packages/vad/src/types/index.ts:154` |

Notes:
- There is **no variable literally named "redemption frames"** — the codebase only has `redemptionMs` (a duration in ms). Comment: "Timing (in milliseconds - vad-web handles frame conversion internally)" (`packages/vad/src/processors/VADProcessor.ts:287`).
- **`postSpeechPadMs` is NOT a native `vad-web` option.** `VADProcessor` implements it itself by zero-padding the returned buffer post-hoc: `appendPostSpeechPad()` computes `const padSamples = Math.floor((padMs / 1000) * this.options.sampleRate);` (`packages/vad/src/processors/VADProcessor.ts:421`) and appends zero samples (Float32Array is zero-initialized). Doc comment explains why: "The underlying `@ricky0123/vad-web` library only exposes `preSpeechPadMs` and `redemptionMs`; it does not have a true `postSpeechPadMs`." (`VADProcessor.ts:374-378`).
- **Production override diverges from the package defaults.** `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts:145-151` constructs the live VAD instance as:
  ```
  positiveThreshold = this.config.vad.sensitivity ?? 0.5                                   // :144
  negativeSpeechThreshold: this.getVADNegativeThreshold(positiveThreshold)                  // :147
  minSpeechMs: this.config.vad.minSpeechDuration ?? 250                                     // :148
  redemptionMs: this.config.vad.minSilenceDuration ?? 500                                   // :149
  ```
  with `getVADNegativeThreshold(positiveThreshold) { return Math.max(0.1, Math.min(0.95, positiveThreshold - 0.15)); }` (`TranscriptionPipeline.ts:632-634`), and `DEFAULT_VAD_CONFIG = { enabled: true, sensitivity: 0.5, minSpeechDuration: 250, minSilenceDuration: 500 }` (`packages/agentic-sdk-v2/src/core/constants.ts:966-971`). **So the shipped production `redemptionMs` is effectively 500ms, not the package's own 1400ms default** — `preSpeechPadMs`/`postSpeechPadMs`/`silenceResetMs`/`sampleRate` are left unset by `TranscriptionPipeline` and therefore still fall back to `VADProcessor`'s own `DEFAULT_VAD_OPTIONS` (300 / 300 / 5000 / 16000).
  - **Threshold-formula inconsistency (worth flagging for the review):** `PluginManager.ts` re-derives the negative threshold with a *different* formula when propagating a live sensitivity change: `// Mirror TranscriptionPipeline.getVADNegativeThreshold: 0.7× the positive threshold.` followed by `const negative = Math.max(0, nextSensitivity * 0.7);` (`packages/agentic-sdk-v2/src/core/PluginManager.ts:664-666`). This is **not actually the same formula** as `TranscriptionPipeline.getVADNegativeThreshold` (`positiveThreshold - 0.15`, clamped `[0.1, 0.95]`) — they only coincide at the default `0.5` (`0.5-0.15=0.35` vs `0.5*0.7=0.35`); at other sensitivities they diverge (e.g. `positiveThreshold=0.8` → `0.65` vs `0.56`).

## 4. Frame size

- **`FRAME_SIZE_V5 = 512`** (`packages/vad/src/utils/frameProcessor.ts:13`, comment: "Frame size for Silero VAD v5 (512 samples).", line 11-13).
- **`FRAME_SIZE_LEGACY = 1536`** (`packages/vad/src/utils/frameProcessor.ts:18`, comment: "Frame size for legacy Silero VAD (1536 samples).", line 15-18).
- Cross-confirmed by `getFrameSamplesForModel(model)`: `return model === 'v5' ? 512 : 1536;` (`packages/vad/src/utils/browserSupport.ts:142-144`).
- Type-doc also states it: "'v5': Latest Silero VAD v5 with 512-sample frames (recommended)" / "'legacy': Legacy model with 1536-sample frames" (`packages/vad/src/types/index.ts:13-14`).
- **Important caveat**: `FrameAccumulator` (the class that actually consumes `FRAME_SIZE_V5`/`FRAME_SIZE_LEGACY` at `packages/vad/src/utils/frameProcessor.ts:43-150`) is **not imported or used by `VADProcessor.ts`** — confirmed by re-reading `VADProcessor.ts`'s import list (only `../types/index.js`, `../utils/browserSupport.js`, `../constants.js`) and by a repo-wide grep for `FrameAccumulator`, which only found it in `packages/vad/src/index.ts` (barrel re-export), `packages/vad/src/utils/index.ts` (barrel re-export), `packages/vad/src/utils/frameProcessor.ts` (definition), and `packages/vad/e2e/vad.e2e.spec.ts` (its own e2e test) — no downstream package (`agentic-sdk-v2`, `room`, `stt`, `ui-playground`) imports it. The real-time 512-sample framing actually happens **inside** `@ricky0123/vad-web`'s `MicVAD` / its internal AudioWorklet, which is external to this repo. `FrameAccumulator`/`AudioRingBuffer`/`durationToFrames`/`framesToDuration` are exported public utilities for custom non-real-time pipelines, not wired into the shipped real-time path.

## 5. Sample rate & resampling

- **`VAD_SAMPLE_RATE = 16000`** (`packages/vad/src/utils/resampler.ts:13`).
- `VADOptions.sampleRate` defaults to `16000` (`types/index.ts:150`) but its JSDoc clarifies it is **not** an input-resample control: "Sample rate for output audio in speech end events. **The VAD model always processes at 16kHz internally.**" (`packages/vad/src/types/index.ts:86-90`). In `VADProcessor` it is used only for the post-speech-pad sample-count math (`appendPostSpeechPad`, `VADProcessor.ts:421`), never to resample the live mic stream.
- **`VADProcessor` does NOT resample the mic input itself and does NOT import `resampler.ts` at all** (confirmed: its import list has no `../utils/resampler.js`). `onInit()` creates `sourceNode = audioContext.createMediaStreamSource(stream)` purely for a passthrough connection to `destinationNode` (`VADProcessor.ts:236-247`), and hands the **raw, unresampled `MediaStream`** straight to `MicVAD.new({ ..., getStream: async () => stream })` (`VADProcessor.ts:279-325`). Resampling from the browser's native `AudioContext.sampleRate` (typically 44.1kHz/48kHz) down to 16kHz happens **inside `@ricky0123/vad-web`'s internal worklet**, external to this repo. `packages/vad/src/utils/resampler.ts`'s own doc says this explicitly: "The processor itself delegates real-time resampling to `MicVAD`'s internal worklet, but callers that pre-buffer audio or run non-real-time inference should funnel through this helper instead..." (`resampler.ts:143-146`).
- **Algorithm**: linear interpolation, delegated to `@arcaai/room`'s `resampleAudio` (`packages/vad/src/utils/resampler.ts:8, 24-26`). The actual implementation, `packages/room/src/utils/audioUtils.ts:137-156`:
  ```ts
  export function resampleAudio(samples: Float32Array, fromSampleRate: number, toSampleRate: number): Float32Array {
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
    return result;
  }
  ```
  Doc comment: "Uses linear interpolation for simplicity." (`audioUtils.ts:130`) — **not** polyphase, **not** simple decimation (it does interpolate between neighboring samples, not just drop samples).
  Source/target rates are generic parameters (`fromSampleRate`, `toSampleRate`); `packages/vad`'s `Resampler` class defaults `outputSampleRate: number = VAD_SAMPLE_RATE` i.e. `16000` (`resampler.ts:45`), and `downsampleTo16kHz`/`resampleToVADRate` both target `VAD_SAMPLE_RATE` (`resampler.ts:118-120, 152-157`).
  This whole `resampler.ts` module (`Resampler` class, `linearResample`, `downsampleTo16kHz`, `upsampleFrom16kHz`, `resampleToVADRate`) is, like `FrameAccumulator`, **unused by the shipped real-time path** — repo-wide grep for its exports (excluding its own barrel/tests) only found usage in `packages/vad/e2e/vad.e2e.spec.ts` and `packages/vad/examples/transcription-integration.ts` (an example file, `packages/vad/examples/transcription-integration.ts:8`, not shipped runtime code).

## 6. Events / callbacks emitted by `VADProcessor`

All emitted through `BaseProcessor.emitData<T>(type, data)` (`packages/room/src/processors/BaseProcessor.ts:264-270`), which wraps as the generic `ProcessorEvent.Data` (`= 'data'`, `packages/room/src/events/ProcessorEvents.ts:26`) event with payload shape `{ type: string; data: T; timestamp: number }` (`ProcessorEvents.ts:44-52`).

| Emitted `type` string | Handler (VADProcessor.ts) | Payload type & shape | Direct callback (constructor option) |
|---|---|---|---|
| `'vad-speech-start'` | `handleSpeechStart()` (`:341-354`) | `VADSpeechStartPayload = { timestamp: number }` (`types/index.ts:245-250`) | `onSpeechStart?: () => void` (`:124`, called `:353`) |
| `'vad-speech-real-start'` | `handleSpeechRealStart()` (`:359-369`) | `VADSpeechRealStartPayload = { timestamp: number }` (`types/index.ts:256-261`) | `onSpeechRealStart?: () => void` (`:125`, called `:368`) |
| `'vad-speech-end'` | `handleSpeechEnd(audio)` (`:380-411`) | `VADSpeechEndPayload = { audio: Float32Array; segmentNumber: number; startTime: number; endTime: number; streamStartSec: number; streamEndSec: number; durationSec: number; duration: number }` (`types/index.ts:266-312`) | `onSpeechEnd?: (audio: Float32Array) => void` (`:126`, called `:410` with the **padded** audio) |
| `'vad-misfire'` | `handleVADMisfire()` (`:432-449`) | `VADMisfirePayload = { duration: number; timestamp: number }` (`types/index.ts:318-328`) | `onVADMisfire?: () => void` (`:127`, called `:448`) |
| `'vad-frame'` | `handleFrameProcessed(probabilities, frame)` (`:454-506`) | `VADFramePayload = { isSpeech: boolean; probability: number; notSpeechProbability: number; timestamp: number }` (`types/index.ts:220-240`) | `onFrameProcessed?: (probabilities: { isSpeech: number; notSpeech: number }, frame: Float32Array) => void` (`:128`, called `:505`) |
| `'vad-stats'` | `startStatsEmission()` interval (`:517-526`) | `VADStats = { isActive, isSpeaking, speechProbability, currentSpeechDuration, framesProcessed, speechSegmentsDetected, misfireCount, averageSpeechProbability, timestamp }` (`types/index.ts:164-210`) | none (event-only; polled/consumed via `getStats()` too) |

`isSpeechFrame` (the boolean gate in the `'vad-frame'` payload) is computed as `probabilities.isSpeech > this.options.positiveSpeechThreshold` (`VADProcessor.ts:481`) — note strictly-greater-than, not `>=`.

## 7. Downstream consumption — where VAD output is wired into the pipeline

Confirmed by grep across the repo (excluding `.claude/worktrees` and `node_modules`) for `VADProcessor`, `useVAD`, and `@arcaai/vad` imports.

**Primary production wiring — `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts`** (imported as part of the `NoiseFilter → VAD → STT` sequential pipeline, `TranscriptionPipeline.ts:4`):
- VAD stage factory: `const { createVAD } = await import('@arcaai/vad'); ... return createVAD({ positiveSpeechThreshold, negativeSpeechThreshold, minSpeechMs, redemptionMs, debugMode });` (`TranscriptionPipeline.ts:136-153`).
- Generic event bridge: every stage's `ProcessorEvent.Data` is routed by name — `case 'vad': this.handleVADEvent(payload); break;` (`TranscriptionPipeline.ts:654-657`).
- `handleVADEvent(payload)` (`TranscriptionPipeline.ts:686-748`):
  - `'vad-speech-start'` → re-emitted as pipeline event `vadEvent` with `{ type: 'speech-start', timestamp }` (`:687-692`) — UI/telemetry only.
  - `'vad-speech-end'` → re-emitted as `vadEvent` `{ type: 'speech-end', timestamp, audioData, segmentNumber, streamStartSec, streamEndSec, durationSec }` (`:693-710`), **and**, critically, when the STT stage's provider is local (`sttProcessor.getProviderType?.() === 'local'`) and exposes `transcribeSegment`, VAD's speech-end **directly triggers transcription**: `sttProcessor.transcribeSegment(data.audio)` (`:712-721`), whose result is enriched with `vadSegmentNumber`/`vadStreamStartSec`/`vadStreamEndSec`/`vadDurationSec` and emitted as `'transcription'` (`:722-736`).
  - `'vad-misfire'` → re-emitted as `vadEvent` `{ type: 'misfire', timestamp }` only (`:741-746`).
- **Hard gating of continuous STT frame sends (local/browser Whisper path only)**: `const useVadGate = runtimeProvider === 'local' && this.config.vad.enabled;` (`TranscriptionPipeline.ts:166`), forwarded into the STT processor's feature flags as `vadGate: useVadGate` (`TranscriptionPipeline.ts:193`). Consumed in `packages/stt/src/core/STTProcessor.ts`'s per-frame audio-capture callback:
  ```ts
  this.captureHandle = await createAudioCapture(audioContext, track, (frame) => {
    if (!this.provider || !this._enabled) return;
    const features = this.options.features as STTFeatureFlags | undefined;
    if (features?.vadGate) return;                       // STTProcessor.ts:773-775 — early return, frame dropped
    this.provider.processAudio(frame, audioContext.sampleRate);   // STTProcessor.ts:777
  });
  ```
  (`packages/stt/src/core/STTProcessor.ts:766-779`). So when `vadGate` is true, **continuous mic frames are never sent to the local Whisper provider at all** — transcription happens exclusively via the `transcribeSegment(data.audio)` call fired from VAD's `'vad-speech-end'` above. `STTFeatureFlags.vadGate` doc: "If true, disable continuous frame feeding and expect external segment calls via `transcribeSegment()` (e.g. VAD-gated speech-only processing)." default `false` (`packages/stt/src/types/index.ts:183-188, 226`).
  - **This gate is local-only.** `resolveSTTRuntimeProvider()` defaults to `'remote'` whenever a `streamingTransport`/`sttSocket` exists (`TranscriptionPipeline.ts:611-618`), which is the typical backend-streaming production configuration; in that case `useVadGate` is always `false` (since `runtimeProvider !== 'local'`), so `STTProcessor` keeps streaming every frame via `processAudio` regardless of VAD state (`STTProcessor.ts:777`), and `supportsSegmentTranscription` in `handleVADEvent` also evaluates `false` (requires `getProviderType() === 'local'`, `TranscriptionPipeline.ts:717`) — so for the remote/backend STT path, **VAD only drives the `vadEvent`/UI-indicator channel and never gates or triggers the actual transcription send.**

**Secondary wiring — `packages/agentic-sdk-v2/src/core/PluginManager.ts`** (consumes `TranscriptionPipeline`, not `VADProcessor` directly):
- Stores the live VAD processor: `const vadProcessor = this.transcriptionPipeline.getProcessor('vad'); if (vadProcessor) { this.processors.set('vad', vadProcessor); }` (`PluginManager.ts:437-440`).
- Bridges pipeline `vadEvent` out to the SDK's public callback surface: `this.transcriptionPipeline.on('vadEvent', (event) => { this.callbacks.onVADEvent?.(event); });` (`PluginManager.ts:818-820`), backing the public `onVADEvent?: (event: VADEvent) => void;` callback (`PluginManager.ts:71`).
- Builds the pipeline's `vad` config block from `AudioPluginConfig` + user prefs (`getTranscriptionPipelineConfig()`, `PluginManager.ts:587-593`).
- Live sensitivity propagation calls `VADProcessor.updateThresholds()` directly: `const proc = pipeline.getProcessor('vad') as {...}; await proc?.updateThresholds?.({ positiveSpeechThreshold: nextSensitivity, negativeSpeechThreshold: negative });` (`PluginManager.ts:660-666`, discussed under Q3's threshold-formula-divergence note).
- Exposes coarse VAD activity state: `vad: { isActive: vad?.isEnabled() ?? false, isSupported: this.isEnabled('vad') }` in `getStates()` (`PluginManager.ts:880-883`).

**`packages/room/src/`**: does **not** import `@arcaai/vad` or `VADProcessor` at all in production code — the two grep hits are JSDoc example comments only (`packages/room/src/core/AudioTrack.ts:77` — `* await track.setProcessor(myVADProcessor);`; `packages/room/src/hooks/useProcessors.ts:62` — `*     const vadProcessor = createVADProcessor();`), illustrating the generic `TrackProcessor` interface that `VADProcessor` (defined in the separate `@arcaai/vad` package) happens to implement. `packages/room/src/__tests__/audio-pipeline.e2e.test.ts` defines its own local `MockVADProcessor` class for pipeline tests, unrelated to the real `VADProcessor`.

**Tertiary / deprecated consumer — `apps/ui-playground/`**: imports `createVAD` from `@arcaai/vad` directly (bypassing `TranscriptionPipeline`) in `apps/ui-playground/src/features/audio/components/transcript-panel.tsx:19`, implementing its own ad-hoc "VAD sidecar" gating (`vadGatedMode`, `vadThreshold`, `destroyVadSidecar`, `updateVadSpeechProbability` — same file, e.g. `:617, 721-722, 733, 747-758, 912-987`) that switches STT `chunkLengthS`/`overlapLengthS` and sets its own `vadGate` on `useSTT`. Also documented (non-functional, doc-only) in `apps/ui-playground/src/features/installation/pages/vad.tsx:9-35`. Per this repo's own rules (`CLAUDE.md` / `.claude/rules/07-react-ui.md`), `apps/ui-playground` is **deprecated with no development plan** — this is a legacy/demo consumer, not the production path.

---

### Summary of notable review-relevant findings (all citation-backed above)
1. Model/runtime assets are 100% CDN-fetched at runtime by default (jsDelivr), not self-hosted or vendored — a network dependency on the hot path of every session start unless a consumer overrides `baseAssetPath`/`onnxWASMBasePath`.
2. Threading is capped at 8 and requires `crossOriginIsolated`; without COOP/COEP the WASM runs single-threaded (`numThreads = 1`).
3. No explicit SIMD/execution-provider configuration exists in `packages/vad/src` — both are left to `onnxruntime-web` defaults.
4. Production `redemptionMs` (speech-end silence hang time) is actually **500ms** (via `TranscriptionPipeline`/`DEFAULT_VAD_CONFIG`), not the package's documented **1400ms** default — a 2.8× difference in end-of-utterance latency depending which default you read.
5. Two divergent negative-threshold formulas exist between initial pipeline construction (`TranscriptionPipeline.getVADNegativeThreshold`, `positiveThreshold - 0.15`) and live-update propagation (`PluginManager`, `positiveThreshold * 0.7`) — coincide only at the default `0.5` sensitivity.
6. `FrameAccumulator`/`AudioRingBuffer`/frame-duration helpers (`frameProcessor.ts`) and the entire `resampler.ts` module are exported public API surface but are dead code with respect to the real-time path — real-time framing/resampling happens inside the external `@ricky0123/vad-web` dependency.
7. VAD only performs a hard gate on STT audio sends for the **local/browser Whisper** provider path; for the **remote/backend streaming** STT path (the typical production configuration), VAD output is UI/telemetry-only and does not gate or trigger transcription sends.
