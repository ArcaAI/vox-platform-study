# 03 — Local Pipeline (on-device live transcription)

**Reviewer:** A3 | **Date:** 2026-05-24 | **Scope:** `room`, `vad`, `noise-filter`, `stt`, `med-ner`, plus `@arcaai/vox` orchestration (`PluginManager`, `TranscriptionPipeline`, `PersonalizationManager`, `useArca*`).

## 1. Method

Re-verified each TASK-262 finding against current source. Skimmed orchestration to map feature toggles. Inspected key remediation tickets (267-277 — all marked Completed). Cited file:line for every defect.

## 2. Architecture sketch

```
getUserMedia
  └─► AudioTrack (room) ── AudioContextManager (singleton, StrictMode-safe)
       └─► ProcessorPipeline / TranscriptionPipeline (vox)
            ├─► NoiseFilter   (AudioWorklet + RNNoise WASM, ring-buffer)        [toggleable]
            ├─► VAD           (Silero v5 via @ricky0123/vad-web, passthrough)    [toggleable]
            └─► STT           (Whisper via WorkletNode + WebWorker engine)       [model select]
                  └─► LocalSpeakerDiarizer (FFT+MFCC, cosine centroids)         [diarization]
                        └─► TranscriptionResult → onTranscription callback
```

VAD-gate path: when `vad.enabled` and provider=local, `TranscriptionPipeline.handleVADEvent` calls `sttProcessor.transcribeSegment(audio)` on `vad-speech-end` (`TranscriptionPipeline.ts:643-671`).

## 3. Configurable-feature matrix

| Feature | Config key | Default | Runtime toggle | Capability-gated | Where enforced | Verdict |
|---|---|---|---|---|---|---|
| STT model | `stt.modelId` | `'tiny'` (`TranscriptionPipeline.ts:574`) | No — requires `updateConfig` + restart | No | `TranscriptionPipeline.setupStageFactories` `stt` factory line 162-187 | **Partial** (no live swap; full re-init only) |
| Translation | — | — | — | — | Not implemented anywhere (`rg translate` in `packages/stt/src` returns 0 hits) | **Not met** |
| Code-switching | `stt.codeSwitching` | `false` (`PluginManager.ts:461`) | No — baked into cache key (`STTProcessor.ts:439`) → forces provider re-init | No (works on every multilingual Whisper) | `WhisperEngine.ts:140` (`allowAutoLanguage`), `STTProcessor.ts:151` | **Partial** (works but not "runtime-toggleable" without provider eviction) |
| Noise filter | `noiseFilter.enabled` + `.level` | `false` | Yes (`PluginManager.setEnabled('noiseFilter')` → `TranscriptionPipeline.toggleStage` line 457-490) | No | `PluginManager.ts:589-622`, `TranscriptionPipeline.ts:457-490` | **Met** |
| VAD | `vad.enabled` + `.sensitivity` | `false` | Yes (`toggleStage('vad')`) | Browser support gate inside `VADProcessor.isSupported` | same path | **Met** |
| Diarization (voice prereq) | `stt.diarization` + `.numSpeakers` | `false` | No — cache-key field; requires provider re-init (`STTProcessor.ts:441`) | **NOT gated on voice profile** — `useVoiceEmbedding.ts` exists but never read by `STTProcessor`/`LocalSpeakerDiarizer`. `Diarizer.identifySpeaker` (`LocalSpeakerDiarizer.ts:170+`) only checks `centroids.length` | `LocalSTTProvider`→`Diarizer` constructor; never asserts enrolled voice | **Not met** (gating absent) |

## 4. TASK-262 remediation status

| ID | Status | Evidence | Notes |
|---|---|---|---|
| room CRITICAL-1 (StrictMode AudioContext leak) | **Fixed** | `AudioContextManager.ts:118-176` — `acquire()` cancels `pendingClose`; `release()` defers close via `queueMicrotask`. Tests in TASK-268 §W1-2. | Robust |
| room CRITICAL-2 (`createLocalTracks` leaks AudioContext) | **Fixed** | TASK-268 acceptance W1-3; `Room.ts` rewires through `AudioContextManager.acquire`/release | Verified via TASK-268 README §3 |
| room HIGH-1 (`getUserMedia` errors → UNKNOWN) | **Fixed** | TASK-268 W1-3 — typed error subclasses; `AudioTrack.ts` error mapping extended | OK |
| room HIGH-2 (track-ended cleanup) | **Fixed** | TASK-268 W1-4 — `MediaStreamTrack.onended` now calls internal stop | OK |
| room HIGH-3 (`resumeWithTimeout` silent race) | **Fixed** | `AudioContextManager.ts:307-341` — throws `RoomResumeTimeoutError`, sets up click handler unconditionally when `state !== 'running'` | OK |
| room MEDIUM-2 (rebuild destroys all WASM on toggle) | **Not fixed** | `ProcessorPipeline.rebuildPipeline` still calls `destroyAllProcessors` + `buildPipeline`; no soft-bypass. `TranscriptionPipeline.toggleStage` (line 457-490) now calls `processor.enable/disable` instead of rebuild — partial mitigation only for the vox pipeline, not the underlying `ProcessorPipeline` | Mitigated at vox layer; underlying defect remains |
| vad C-1 (CDN pinned to vad-web 0.0.29) | **Fixed** | `packages/vad/src/constants.ts:40` — `@ricky0123/vad-web@${VAD_WEB_VERSION}`; test pin in `__tests__/constants.test.ts:47` | OK |
| vad C-2 (onnx pinned to 1.22.0) | **Fixed** | `constants.ts:49` — `${ORT_WEB_VERSION}` template | OK |
| vad C-3 (custom worklet dead code) | **Not fixed** | `registerVADWorklet`, `createVADWorkletNode`, `cleanupVADWorkletResources`, `VADWorkletConfig`, `VADWorkletInboundMessage` still in `publicExports.test.ts:20-23` and still exported. `VADProcessor` does not attach them. | Dead code remains in public API |
| vad H-1 (LSTM hidden-state never reset between sessions) | **Not fixed** | `VADProcessor.ts` exposes no `resetState`/`restart`; no `micVAD.destroy()+re-init` on pause/start | Outstanding |
| vad H-2 (unbounded `probabilitySum`) | **Not fixed** | `VADProcessor.ts:111-112,366-368` — still naive running sum; no sliding window | Outstanding |
| stt C-1 (`prompt` dropped on local path) | **Fixed** | `WhisperEngine.ts:159-161` — `transcribeOptions.initial_prompt = options.prompt`; test `packages/stt/src/__tests__/prompt-wiring.test.ts` | OK |
| stt C-2 (audio copied not transferred) | **Fixed** | `WhisperWorkerEngine.ts:386-390` — `sendWorkerRequest(type, payload, transfer)`; audio buffer transferred | OK |
| stt C-3 (ScriptProcessorNode 4096) | **Fixed (preferred path)** | `packages/stt/src/core/audioCapture.ts:74-96` — `AudioWorkletNode` (`stt-capture` worklet) on capable contexts; `ScriptProcessorNode` only on legacy fallback with `console.warn` once | OK |
| stt H-4 (static `localProviderPool`) | **Not fixed** | `STTProcessor.ts:87` — `private static localProviderPool = new Map<...>` remains a class-level singleton (cross-instance, cross-test). `releaseWarmResources` exists but pool itself is still static | Outstanding |
| stt H-6 (linear backoff WS) | **Partially fixed** | TASK-270 changelog claims exponential added; `BackendSTTProvider.ts` reconnect not in scope (LOCAL pipeline); see `04-remote-pipeline.md` for the canonical verdict | N/A (remote scope) |
| noise-filter CRIT-1 (malloc per frame) | **Fixed** | `RNNoiseProcessor.ts:54-55,111-112,233-244` — `inputPtr`/`outputPtr` allocated once at `init`, freed at destroy; test `__tests__/preallocation.test.ts` | OK |
| noise-filter CRIT-2 (CDN-only WASM) | **Fixed** | `NoiseFilterProcessor.ts:226` — `getDefaultWasmUrl()` returns bundled `assets/rnnoise.wasm`; `package.json` `exports['./wasm']` for self-host | OK |
| noise-filter HIGH-1 (output gap / silence) | **Fixed** | `RNNoiseProcessor.ts:13,61,124,165` + `rnnoise.worklet.ts:14` — 2×FRAME ring buffer with one-frame prime latency; test `__tests__/ringBuffer.test.ts` | OK |
| noise-filter HIGH-5 (wrong API types / silent denoise) | **Fixed** | `rnnoise-wasm.d.ts:17` realigned to actual Emscripten exports (`_malloc`, `rnnoise_process_frame(state, out, in) -> VAD`); `RNNoiseProcessor.ts:175` reads VAD return, denoised samples from `outputView` | OK |
| med-ner C-1 (main-thread blocking) | **Fixed** | `MedNERProcessor.ts:130,201,267-308` — `workerFactory` option spawns Worker, `MedNERWorkerClient` proxies init/extract | OK |
| med-ner C-2 (char-boundary chunking) | **Partially fixed** | `aggregation_strategy: 'simple'` set at `MedNERProcessor.ts:322`, plus token-aware tokenizer chunker (`this.tokenizer = this.buildTokenizer(...)`). Char-based fallback path in `chunkText` still exists (not in scope of TASK-272/277) | Mitigated |
| med-ner H-6 (`##` subword fragmentation) | **Fixed** | `aggregation_strategy: 'simple'` in pipeline options merges BIO subwords before crossing worker boundary | OK |

## 5. Cross-cutting defects (Critical/High remaining)

- **[HIGH]** Diarization is **not** gated on a voice profile. Business requirement violated. `STTProcessor.ts:441` puts `diarization` in the local-provider cache key but neither `LocalSTTProvider` nor `LocalSpeakerDiarizer` checks `PersonalizationManager`/`useVoiceEmbedding` enrolment before activating. Should refuse `features.diarization=true` (or downgrade) when no voice sample is registered. See also `02-voice-enrollment.md`.
- **[HIGH]** Translation feature completely missing. Whisper's `task: 'translate'` is never set anywhere in `packages/stt/src/engines/WhisperEngine.ts` or worker. The matrix row is therefore unimplementable today; no model-capability gate exists.
- **[HIGH]** VAD H-1: Silero LSTM `(h,c)` hidden state is never reset across `pause()`/`start()` (`packages/vad/src/processors/VADProcessor.ts:441-499`). Across multi-speaker consultation segments, residual activations bias the next speaker's probabilities. Add `restart()` that calls `micVAD.destroy(); initMicVAD(this.stream)`.
- **[HIGH]** VAD H-2: `probabilitySum`/`probabilityCount` unbounded (`VADProcessor.ts:111-112,366-368`). Long consultations lose precision; replace with sliding window (~1000 frames).
- **[HIGH]** STT H-4 cross-process pool: `STTProcessor.ts:87` `private static localProviderPool` survives across React trees and test runs; not StrictMode-disposed. Move to module-level WeakMap keyed on AgenticClient or guard with `releaseWarmResources` on `useArca` unmount.
- **[HIGH]** Dead VAD worklet still in public API: `packages/vad/src/utils/workletLoader.ts` exports + `publicExports.test.ts:20-23` pin them. Calling these has no effect; misleads SDK consumers. Either wire them through `VADProcessor` or remove from `src/index.ts`.
- **[HIGH]** `setLanguage` on local STT silently no-ops (`STTProcessor.ts:332-335` only `console.warn`). Hook callers expect immediate effect. Either reinit local provider (cache-key already captures language → would Just Work) or throw.
- **[CRITICAL]** Sample-rate mismatch unchecked: `TranscriptionPipeline.start` (line 194-307) passes `audioContext` straight through; on macOS 44.1 kHz hardware, RNNoise (`RNNOISE_SAMPLE_RATE=48000`) and Silero (16 kHz expected, handled internally) operate at wrong frame timing. `room` still ships no `AudioContext.sampleRate` enforcement (TASK-262 MEDIUM-1 unaddressed). For RNNoise this materially degrades quality — borderline correctness.
- **[HIGH]** Diarizer FFT bit-reversal still incorrect: `LocalSpeakerDiarizer.ts:307-316` writes `real[rev] = frame[i]` without `rev > i` guard, overwriting unread inputs. Subtle accuracy drop, not a crash.

## 6. Security

PHI in audio buffers traverses worker `postMessage` boundaries with `Transferable` (good — no copy retained on sender side). However:
- **SAB / COOP·COEP**: Multi-threaded WASM is not opted in by either VAD (`VADProcessor` never sets `ort.env.wasm.numThreads`) or STT worker (`whisper.worker.ts:135-136` hard-codes `numThreads=1`). No package README documents the required `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` for the apps that embed Vox.
- **Asset SRI**: WASM/ONNX assets are no longer CDN-defaulted (noise-filter CRIT-2 fixed; VAD constants reference jsDelivr but track installed pkg version). Still no SHA-384 manifest or `integrity` enforcement; `assets/README.md` does not provide hashes.
- **PHI in audio**: `STTProcessor.debugMode` logs `DebugTranscriptEntry` (text + speaker + timestamps) via `console.debug` (`STTProcessor.ts:146-157`). A Sentry/Datadog browser SDK in the consuming app captures this. Add a redaction guard or disable when `process.env.NODE_ENV==='production'`.
- **Biometric (HIPAA Art.9 GDPR)**: `LocalSpeakerDiarizer` returns 58-dim feature vector inside `TranscriptionResult` (`stt/src/types/index.ts:408-419`); persisted by any consumer that stores transcripts.

## 7. Performance

| Stage | Budget | Observed |
|---|---|---|
| Capture (AudioWorklet) | <1 ms/frame | OK (`audioCapture.ts:74-153`) |
| RNNoise (48 kHz, 480 samples) | 10 ms frame; ~0.2-0.5 ms inference | OK after CRIT-1 fix |
| Silero v5 inference | 32 ms frame + 5-15 ms WASM | OK on desktop; mobile borderline. WebGPU/SAB not wired |
| Whisper segment (tiny @ 5s segment) | 200-800 ms WASM, 80-200 ms WebGPU | Acceptable; **`whisper.worker.ts` hard-codes `numThreads=1`** even when SAB is available |
| Diarizer per segment | <50 ms | OK; FFT bit-reversal bug aside |
| MedNER (when ON) | 150-400 ms WASM | Now in worker (TASK-272) |

Hot-path allocations: room LOW-2 `Float32Array(2048)` per 50 ms tick — `TASK-268 W1-6` reports preallocation; OK. RNNoise `Float32Array.subarray` per frame — zero-copy, OK. `TranscriptionPipeline` `MediaStreamAudioSourceNode/DestinationNode` chained per stage — still 3 buffer copies between `noise → vad → stt` (TASK-262 §6.2 of `02-room.md`, unaddressed).

## 8. Test coverage gaps

| Area | Gap |
|---|---|
| Diarization-without-voice-profile guard | No test (feature absent) |
| STT translation task | No test (feature absent) |
| STT live `modelId` / `language` swap | No test; `STTProcessor.setLanguage` only warns |
| VAD `pause`/`start` LSTM reset | No test |
| VAD threshold validation (neg ≥ pos) | No test |
| `numThreads > 1` WASM path | No test in `vad` or `stt` |
| ProcessorPipeline soft-bypass on toggle | No test; TASK-268 vox-level toggle is tested but `room` `ProcessorPipeline.rebuildPipeline` destructive path still runs in some code paths |
| Sample-rate mismatch warning (44.1 kHz context) | No test in `room`/`noise-filter` |
| `localProviderPool` static eviction across React trees | No multi-tree test |
| Bit-reversal correctness in `LocalSpeakerDiarizer` FFT | No reference-FFT comparison |
| MedNER `extractChunked` token-boundary chunking | Partial (char-fallback path uncovered) |

## 9. Conformance to business requirement

| # | Feature | Verdict |
|---|---|---|
| 1 | STT model selectable | **Met** (init-time); **Partial** runtime swap |
| 2 | Translation when supported | **Not met** |
| 3 | Code-switching when supported | **Met** (init-time); **Partial** runtime |
| 4 | Noise filter toggleable | **Met** |
| 5 | VAD toggleable | **Met** |
| 6 | Diarization gated on voice sample | **Not met** |

## 10. Recommended fixes

**P0 (block GA)**
- Implement diarization voice-profile gate in `STTProcessor.validateConfig` (throw or downgrade when `features.diarization && !personalizationManager.hasVoiceProfile()`).
- Add translation: extend `STTFeatureFlags` with `task: 'transcribe' | 'translate'`; pipe to `transcribeOptions.task` in `WhisperEngine.ts:142`; capability-check `!isEnglishOnlyModel` (.en models reject `task`).
- Sample-rate guard: `AudioContextManager.acquire` should warn (or throw with override) when `sampleRate !== 48000` before noise-filter is enabled.

**P1 (next sprint)**
- VAD `restart()` API that destroys+recreates `MicVAD` for hidden-state reset + threshold/sensitivity hot-reload.
- VAD sliding-window probability average (1024 frames).
- STT live `setLanguage`/`setModelId` that rebuild only the STT stage (use existing local-provider cache-key invalidation).
- Remove (or wire through) dead VAD worklet exports (`registerVADWorklet`, `createVADWorkletNode`, `cleanupVADWorkletResources`, `VADWorkletConfig*` types).
- Move `STTProcessor.localProviderPool` from `static` to per-AgenticClient `WeakMap`.
- Wire `ort.env.wasm.numThreads = navigator.hardwareConcurrency` in `whisper.worker.ts` and `VADProcessor.initMicVAD` when `crossOriginIsolated`.

**P2 (polish)**
- Document COOP/COEP requirements in `packages/{vad,stt,noise-filter}/README.md`.
- Strip biometric `SpeakerVoiceFeatures.vector` from default `TranscriptionResult`; opt-in only.
- Fix `LocalSpeakerDiarizer.computeFFTMagnitudes` bit-reversal (build permuted copy then in-place FFT).
- Add SHA-384 manifest + `pnpm assets:verify` script for `rnnoise.wasm`, Silero ONNX, Whisper ONNX bundles.

## 11. Per-package scorecard

| Package | Correctness | Security | Performance | Test coverage | Best-practice fit |
|---|---|---|---|---|---|
| `@arcaai/room` | 8/10 | 7/10 | 8/10 | 7/10 | 8/10 |
| `@arcaai/vad` | 6/10 (H-1, H-2, dead exports) | 6/10 (no SRI, no thread opt-in) | 6/10 (no SAB/WebGPU) | 6/10 | 7/10 |
| `@arcaai/noise-filter` | 9/10 | 7/10 | 9/10 (post CRIT-1) | 8/10 | 8/10 |
| `@arcaai/stt` | 7/10 (no translation, static pool, setLanguage no-op) | 6/10 (debug PHI, biometric leak) | 7/10 (no SAB threads) | 6/10 | 7/10 |
| `@arcaai/med-ner` | 8/10 (worker now) | 7/10 | 8/10 | 7/10 | 8/10 |
| `@arcaai/vox` orchestration | 7/10 (no voice gate, no translation wiring, modelId swap req. restart) | 8/10 | 8/10 | 7/10 | 8/10 |

---
*End A3 report.*
