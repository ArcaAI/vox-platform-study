# TASK-262 — Vox SDK Deep Assessment

| | |
|---|---|
| Ticket Number | TASK-262 |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Wave-0 + Wave-1A + Wave-1B Completed (Wave-2 Pending) |
| Type | Audit / Refactor / Optimization / Security |
| Owner | Architecture team |
| Scope | `@arcaai/vox`, `@arcaai/room`, `@arcaai/vad`, `@arcaai/stt`, `@arcaai/noise-filter`, `@arcaai/med-ner`, `@arcaai/pipeline` + cross-reference against `apps/api` |

---

## Document Map

This ticket bundles a master synthesis (this file) and nine evidence files. Read this file first; consult the per-area files for line-level findings.

| File | Scope |
|---|---|
| [`README.md`](./README.md) | Executive synthesis, cross-cutting themes, prioritized roadmap (this file) |
| [`01-vox-sdk.md`](./01-vox-sdk.md) | `@arcaai/vox` — orchestrator, public API, store, transport, security |
| [`02-room.md`](./02-room.md) | `@arcaai/room` — `AudioContext` lifecycle, tracks, processor pipeline |
| [`03-vad.md`](./03-vad.md) | `@arcaai/vad` — Silero v5 via `@ricky0123/vad-web`, worklets |
| [`04-stt.md`](./04-stt.md) | `@arcaai/stt` — Whisper local engine, worker, WS client, diarizer |
| [`05-noise-filter.md`](./05-noise-filter.md) | `@arcaai/noise-filter` — RNNoise WASM in worklet + ScriptProcessor fallback |
| [`06-med-ner.md`](./06-med-ner.md) | `@arcaai/med-ner` — Transformers.js token classification |
| [`07-pipeline.md`](./07-pipeline.md) | `@arcaai/pipeline` — sequential / parallel / orchestrator |
| [`08-api-cross-reference.md`](./08-api-cross-reference.md) | Endpoint coverage matrix, drift, auth flow validation, error contract |
| [`09-best-practices-2026.md`](./09-best-practices-2026.md) | Latest tooling, models, and patterns to adopt |

---

## 1. Requirement Analysis

### 1.1 Business context

`@arcaai/vox` is the developer-facing React SDK for the HOPE platform. It exposes a single `AgenticProvider` plus ~25 hooks that let host applications build personalized, on-device, privacy-first medical consultation workflows: live transcription, summarization, DNA writing-style learning, multi-doctor sessions, cross-tab sync, and asynchronous job tracking. The audio packages (`room`, `vad`, `stt`, `noise-filter`, `med-ner`) deliver the on-device pipeline that the SDK wires together; the `pipeline` package provides a generic stage orchestrator currently unused by the audio path.

### 1.2 Acceptance criteria for this assessment

1. Map the structure and public API of every package.
2. Identify gaps, defects, performance, and security issues with file/line citations.
3. Cross-reference the SDK constants and hooks against `apps/api` controllers (REST, WebSocket, SSE).
4. Compare each package against the latest 2026 best practice for its domain (Web Audio, ONNX Runtime Web, Whisper, VAD, noise suppression, on-device NER, React/Zustand, bundling).
5. Produce a prioritized roadmap with concrete remediation patches.

### 1.3 Method

Nine specialist subagents reviewed the code in parallel. Each agent had read access to the full repository and an explicit per-package brief. Findings below are reconciled across reports — every claim is cross-checked against the source files cited in the corresponding detail report.

---

## 2. Executive Summary

### 2.1 Verdict

The vox stack is **architecturally sound but production-fragile**. It demonstrates several mature design choices (reference-counted `AudioContext`, deduplicated 401 refresh, OPFS-aware preference store, typed event protocol on the WebSocket transport) but it ships **24 critical or high-severity defects** that meaningfully impact correctness, security, performance, or developer experience. Several entire features are documented but not actually implemented (`autoExecute` data-flow in pipeline, AudioWorklet path in vad, `prompt` option in stt local path, full medical NER integration into vox).

### 2.2 Severity rollup (count of distinct findings)

| Package | Critical | High | Medium | Low |
|---|---:|---:|---:|---:|
| `@arcaai/vox` | 4 | 6 | 8 | 5 |
| `@arcaai/room` | 2 | 5 | 9 | 6 |
| `@arcaai/vad` | 4 | 5 | 9 | 7 |
| `@arcaai/stt` | 3 | 6 | 10 | 8 |
| `@arcaai/noise-filter` | 3 | 6 | 11 | 8 |
| `@arcaai/med-ner` | 3 | 6 | 6 | 5 |
| `@arcaai/pipeline` | 2 | 5 | 9 | 9 |
| API cross-reference | 3 | 4 | 6 | 2 |
| **Total** | **24** | **43** | **68** | **50** |

### 2.3 Top-10 risks (must fix before next release)

1. **SSE auth via URL query string** — JWT appended to `?token=` in `SSEClient` is logged by CDNs/proxies, replayed in browser history, captured by Highlight.io network recording. HIPAA-relevant. (`packages/agentic-sdk-v2/src/core/SSEClient.ts:64–66`)
2. **Voice-embedding endpoint 100% path mismatch** — every `useVoiceEmbedding` call hits 404. Hook posts JSON to a multipart-only endpoint with the wrong path. (`08-api-cross-reference.md` GAP-02)
3. **Missing consultation-job HTTP controller** — `useConsultationJob.getJob/cancelJob/streamJob` all 404. Async summary jobs cannot be tracked. (`08-api-cross-reference.md` GAP-01)
4. **`useArca.startAudio` leaks a raw `AudioContext` and never stops mic tracks** — diverges from `useArcaAudio` which does it correctly. Microphone LED stays lit. (`01-vox-sdk.md` C-1, C-2)
5. **AudioContextManager closed under React StrictMode** — first effect-cleanup decrements ref-count to 0 and closes the shared context, breaking all subsequent audio. (`02-room.md` CRITICAL-1)
6. **`malloc`/`free` per RNNoise frame on the audio thread** — 200 heap round-trips/sec on a real-time worklet thread, causing audible glitches. (`05-noise-filter.md` CRIT-1)
7. **Whisper worker uses `postMessage` by structured clone, not transferable** — copies up to 1.92 MB per transcription, ~230 MB per hour-long session. (`04-stt.md` C-2)
8. **`ScriptProcessorNode` still in use in `@arcaai/stt`** — deprecated, main-thread, ~93 ms quantum; replacement is `AudioWorkletNode`, already the pattern in `vad`/`noise-filter`. (`04-stt.md` C-3)
9. **`@arcaai/vad` ships dead worklet code while CDN versions are mismatched** — defaults pin `@ricky0123/vad-web@0.0.29` and `onnxruntime-web@1.22.0`, but `package.json` resolves `^0.0.30` and `^1.24.3` — ABI break risk; the custom worklet is never registered or consumed. (`03-vad.md` C-1, C-2, C-3)
10. **Med-NER blocks the main thread** — 300 MB BERT inference runs synchronously on the UI thread. Other packages already use Workers; med-ner does not. (`06-med-ner.md` C-1)

### 2.4 Critical security findings

| ID | Finding | Source |
|---|---|---|
| SEC-A | SSE token in query string (HIPAA exposure) | `01-vox-sdk.md` SEC-1 |
| SEC-B | `patientId`/`doctorId` sent unhashed to Highlight.io | `01-vox-sdk.md` SEC-2 |
| SEC-C | `SecureStorage` is session-scoped; cannot decrypt across reloads | `01-vox-sdk.md` SEC-3 |
| SEC-D | Impersonation token kept in publicly readable Zustand store | `01-vox-sdk.md` SEC-4 |
| SEC-E | `BroadcastChannel` accepts unsigned messages from same-origin | `01-vox-sdk.md` SEC-5 |
| SEC-F | RNNoise WASM loaded from CDN with no SRI | `05-noise-filter.md` CRIT-2 |
| SEC-G | Silero ONNX + worklet bundle loaded from jsDelivr without SRI | `03-vad.md` §5.1 |
| SEC-H | Whisper STT WebSocket has no auth — session ID is the only secret | `04-stt.md` H-1, S-1 |
| SEC-I | NER models pinned to community accounts without `revision` SHA | `06-med-ner.md` §5 |
| SEC-J | `ContextInterceptor` lets `x-tenant-id` header override the JWT tenant claim | `08-api-cross-reference.md` §3.4 |

### 2.5 Per-package score card

| Package | Architecture | Correctness | Security | Performance | Test Coverage | Best-practice fit |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `@arcaai/vox` | B+ | C | C− | C+ | B− | C |
| `@arcaai/room` | B | C+ | B− | C+ | C+ | C+ |
| `@arcaai/vad` | C+ (dead code) | D | C− | B− | D | C |
| `@arcaai/stt` | B− | C | C− | C+ | C+ | C+ |
| `@arcaai/noise-filter` | C (dual source) | D+ | C | C− | D+ | C− |
| `@arcaai/med-ner` | C (no Worker) | C− | C+ | D+ | D | C− |
| `@arcaai/pipeline` | B− | C+ | n/a | B− | B− | C+ |

Letter scale: A excellent, B good, C acceptable with material issues, D poor, F unacceptable.

---

## 3. Cross-Cutting Themes

The same class of defect recurs across multiple packages. Fixing each theme once raises quality across the whole stack.

### 3.1 Audio sample-rate is never enforced

Every audio plugin assumes a sample rate but no layer validates it.

| Plugin | Required rate | Behaviour on mismatch |
|---|---|---|
| Whisper STT | 16 kHz (resamples downstream) | Linear interpolation; aliasing above 8 kHz on 44.1/48 kHz input |
| Silero VAD | 16 kHz (`vad-web` resamples internally) | Hard-coded `sampleRate: 16000` passed to library regardless of `AudioContext.sampleRate` |
| RNNoise | **48 kHz exactly** | `AudioContext` runs at 44.1 kHz on macOS by default; 480-sample frames become 10.88 ms not 10 ms — Opus subbands silently misalign |

Resolution: a single `AudioContextManager.ensureSampleRate(expected)` helper (see `02-room.md` §9 P1-9) plus a sinc resampler shared via `@arcaai/room` will fix all three packages and remove the silent corruption mode.

### 3.2 CDN model loading without SRI / version pinning

| Package | Asset | Where served from | Integrity |
|---|---|---|---|
| `@arcaai/vad` | `silero_vad_v5.onnx`, `vad.worklet.bundle.min.js` | `cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/` | None |
| `@arcaai/vad` | `onnxruntime-web@1.22.0` WASM | `cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/` | None — and version diverges from `package.json` |
| `@arcaai/noise-filter` | `rnnoise.wasm` | `cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm/dist/rnnoise.wasm` | None |
| `@arcaai/stt` | Whisper ONNX | Hugging Face Hub | None |
| `@arcaai/med-ner` | BERT ONNX | Hugging Face Hub | None — community accounts (`Kushtrim/`, `samrawal/`) |

Resolution: ship the WASM/ONNX inside the npm package (already a dependency for RNNoise), or document and enforce manual `wasmPath`/`baseAssetPath` overrides plus per-revision SHA-256 manifest verification at first download.

### 3.3 Dead code that ships in the bundle and misleads consumers

| Package | Dead artifact | Bytes |
|---|---|---|
| `@arcaai/vad` | `src/worklets/vad.worklet.ts` + `dist/worklets/vad.worklet.js` (never registered) | ~6 KB compiled + ~300 lines |
| `@arcaai/vad` | Inline blob worklet duplicate in `worklet-loader.ts` (frames never consumed) | ~4 KB |
| `@arcaai/noise-filter` | `worklet-loader.ts` inline JS string (manually maintained copy of `rnnoise.worklet.ts`; already diverged on `cpuLoad`) | ~8 KB |
| `@arcaai/vox` | `valibot` dependency bundled but never used at runtime | ~30 KB |
| `@arcaai/pipeline` | `StageResult` type, `PipelineEvent.Data` enum value | n/a |

Resolution: delete or use. For the vad worklet, eliminate the public `WORKLET_PROCESSOR_NAME` / `registerVADWorklet` API entirely. For noise-filter, generate the inline string from the compiled worklet at build time (`?raw` import or a tsdown banner plugin).

### 3.4 React 19 / SSR readiness gaps

| Issue | Affected | Effect |
|---|---|---|
| `"use client"` banner alone is insufficient | All audio packages | RSC bundlers may still statically import; modules touch `AudioContext` / `IndexedDB` / `BroadcastChannel` at top level |
| React StrictMode double-mount not handled | `RoomProvider`, `AgenticProvider`, `useAudioTrack` | First effect cleanup closes shared resources before remount |
| `useEffect` cleanup dispatches Promises (`pluginManager.destroy()`) without awaiting | `AgenticProvider:369`, `useArcaAudio` | Errors swallowed; teardown races |
| No `react-server` export condition | All packages | Cannot be safely imported by RSC; no clear "throw with friendly message" stub |

Resolution: adopt the canonical Zustand 5 vanilla-store-plus-Context pattern (`09-best-practices-2026.md` §2), guard every browser global behind lazy initialization, add `react-server` export conditions, and add explicit StrictMode-aware acquire/release semantics to `AudioContextManager`.

### 3.5 Resource leaks from Promise-discarding patterns

| Site | File | Effect |
|---|---|---|
| `executeWithTimeout` does not abort `onExecute` after timeout | `pipeline/PipelineStage.ts:131–146` | Side-effects continue after caller sees rejection |
| `initWasm` not awaited in worklet `handleMessage` | `noise-filter/rnnoise.worklet.ts:93` | Unhandled rejection on compile failure; race against first `process()` |
| `pause()`/`resume()` not awaited in pipeline control | `vox/useArca.ts:1441–1467` | UI state inconsistent with processor state |
| `MicVAD` LSTM hidden state never reset between sessions | `vad/VADProcessor.ts` | Stale activations bleed across speakers |
| `EventSource` named listeners never removed on reconnect | `vox/SSEClient.ts:194–199` | Double-firing on reconnect; listener accumulation |

### 3.6 SDK ↔ API drift

The `08-api-cross-reference.md` audit shows three full-mismatch endpoint families (voice embedding, user settings, consultation jobs), one path-segment mismatch (pipeline validate), and one prefix mismatch (role user-roles). All hooks against these surfaces 404 in production. The root cause is **manual maintenance of `core/constants.ts`**; without OpenAPI codegen the SDK and API will drift again. Adopt the NestJS Swagger spec + `openapi-ts` codegen (R-12 in §6 of the cross-reference doc).

### 3.7 Personalization scaffolding present, real personalization missing

The SDK exposes `PersonalizationManager` and a `prompt` field on `STTOptions`, and the API has `UserPreferencesController` and `useVoiceEmbedding` hooks. **None of this reaches Whisper today**: the local `WhisperEngine.transcribe` and worker `transcribe` paths never pass `initial_prompt` to Transformers.js. Voice embedding endpoints don't exist on the API. There is no per-user VAD calibration. There is no hot-word biasing pipeline.

The product proposition — "personalized on-device STT for medical workflows" — is not implementable end-to-end with the current code. Restoring it is a P0 architectural priority (see §5 R1, R7, R12, R20).

---

## 4. Current State Evaluation

### 4.1 Public surface and entry-point strategy

`@arcaai/vox` exposes four entry points (`tsup.config.ts:83–100`):

```
@arcaai/vox            → core + plugins      (large, default)
@arcaai/vox/core       → no audio plugins    (~200 KB)
@arcaai/vox/plugins    → vad + stt + room + noise-filter
@arcaai/vox/plugins/med-ner → med-ner only (300 MB)
```

This split is a clear strength: medical NER is gated behind an explicit import. However:
- `splitting: false` (`tsup.config.ts:85`) means the `index` entry duplicates everything from `core` + `plugins`. Consumers that import from both pay the price unless their bundler dedupes by module identity.
- `dts: false` requires manual `.d.ts` maintenance — fragile.
- `valibot` is in `dependencies` but not actually used at runtime; it bloats `core` by ~30 KB.

### 4.2 Audio pipeline

```
getUserMedia → AudioTrack (MediaStream)
    │
    ▼
ProcessorPipeline (chains TrackProcessor instances via MediaStream{Source,Destination}Node)
    │
    ▼
[NoiseFilter (RNNoise WASM)] → [VAD (Silero ONNX)] → [STT (Whisper Worker)]
    │                                                     │
    │                                                     ▼
    │                                              transcription events
    ▼
processedTrack (consumed by recorder / analyser / etc.)
```

Strengths: typed plugin contract, reference-counted shared `AudioContext`, async-locked `setProcessor` against rapid React mount cycles, working `AudioMixer` with √N normalization.

Weaknesses (full list in `02-room.md` and the per-plugin reports):
- StrictMode double-mount closes the singleton context (CRITICAL-1).
- `createLocalTracks` leaks a context (CRITICAL-2).
- `resumeWithTimeout` silently treats the timeout branch as success (HIGH-3).
- `handleTrackEnded` does not clean up nodes when the device unplugs (HIGH-2).
- `ProcessorPipeline.rebuildPipeline` destroys every WASM plugin on a single `setEnabled` toggle — 100–500 ms of audible silence on each toggle (MEDIUM-2).
- Each `MediaStream*Node` boundary is a copy; a 3-plugin pipeline copies ~12 MB/s on the audio thread (§6.2 of `02-room.md`). A `SharedArrayBuffer` ringbuffer between worklets would eliminate this.

### 4.3 Knowledge pipeline (med-ner, summarization)

`KnowledgePipeline` exists in `@arcaai/vox` but is documented as **experimental**. `MedNERProcessor` is a standalone class that does **not** implement `@arcaai/room`'s `BaseProcessor` despite declaring `@arcaai/room` as a peer dependency. The `@arcaai/vox` integration shown in the README of `@arcaai/med-ner` does not exist in the codebase. NER inference blocks the main thread.

### 4.4 Backend integration

The `08-api-cross-reference.md` matrix tracks 22 endpoint families. Coverage is:
- 12 families: complete and aligned.
- 5 families: mostly aligned with minor gaps (orphaned constants).
- 4 families: significant drift (consultation jobs, voice embedding, user settings, pipeline validate, role user-roles).
- 1 family: SSE auth via query string is cosmetic — `JwtAuthGuard` does not read `?token=`, so SSE in production fails authentication.

Real-time channels: the WebSocket protocol on `/ws/stt-v2/stream` is fully aligned (binary PCM, JSON control messages, transcript normalization). Linear backoff on reconnect (no jitter) is a stability concern under flaky networks.

### 4.5 State management

A single Zustand store (`agenticStore.ts`, ~490 lines) holds ~40 state fields and ~40 actions. Hooks subscribe via `useAgenticStore()` **without selectors**, causing every component using `useArca()` to re-render on every store mutation. Granular selectors are defined (`agenticStore.ts:554–575`) but unused. This is the single most impactful performance defect in the SDK.

### 4.6 Pipeline orchestration

`@arcaai/pipeline` exists as a generic stage orchestrator but is **not used** by the audio path — vox uses `TranscriptionPipeline` from `agentic-sdk-v2` directly. The package has its own value (sequential / parallel / DAG with retry, timeout, pause/resume) but ships with three significant correctness defects (cancellation does not abort in-flight stages, `executeWithTimeout` ignores retry, `autoExecute` data-flow is not implemented).

### 4.7 Test coverage

Most packages have rich-looking unit-test trees but the **integration paths are largely uncovered**:
- `WhisperWorkerEngine`, `LocalSTTProvider`, `STTProcessor`, `useSTT` hook (only structural tests).
- `useVAD` hook (no `renderHook`, no real attach cycle).
- `MedNERProcessor.init/extract` happy paths.
- `RNNoiseProcessor` with a real WASM instance.
- Audio context leak in `useArca.startAudio`.
- StrictMode mount/cleanup cycles in `RoomProvider`, `AgenticProvider`.
- `BroadcastChannel` injection in `SimpleCrossTabSync`.
- All E2E suites under `*/integration/` are excluded by the Vitest config.

### 4.8 Existing tickets that are partially related

| Ticket | Relevance |
|---|---|
| TASK-234 SDK Security Review Fixes | Removed direct service access; added jitter to one client; SharedWorker introduced. SSE token-in-URL was **out of scope** and remains unfixed. |
| TASK-237 Audio Pipeline Refactor | Introduced `AudioMixer`, `contextOwnership` flag, fixed config toggling. Did not address StrictMode leak or `createLocalTracks` raw context. |
| TASK-244 Audio Config Management Overhaul | Three-tier config cascade (defaults → tenant → user). Did not wire `prompt` to local STT path. |
| TASK-245 Admin User Preferences Impersonation | Admin-side preference store. Voice-embedding REST endpoint mismatch remains. |
| TASK-261 Entity Validate Rollout | Most recent — does not address med-ner main-thread blocking. |

---

## 5. Implementation Plan / Remediation Roadmap

The recommendations are grouped into four waves. Each item has an effort tag (S = ≤1 day, M = 2–5 days, L = 1–2 weeks, XL = ≥2 weeks) and a primary owner suggestion (front-end / SDK / backend / DevOps).

### Wave 0 — Stop-the-bleed (security & data-integrity fixes, ≤2 weeks)

These items must ship before any new feature work on vox. Several are HIPAA-relevant.

| ID | Action | Effort | Source |
|---|---|:---:|---|
| W0-1 | **Remove JWT from SSE URL.** Implement `/auth/stream-ticket` endpoint that issues a single-use, short-TTL ticket; pass ticket as `?ticket=`. Update `JwtAuthGuard` to support both ticket query and `Authorization` header so existing clients keep working. | M | SEC-A, R-06 |
| W0-2 | **Hash `patientId` / `doctorId` in `HighlightTransport`.** Replace raw IDs with SHA-256 prefix. Add `redactFields` enforcement on `user` context, not just `attributes`. | S | SEC-B, R-3 (vox) |
| W0-3 | **Move impersonation token out of Zustand store.** Hold inside `AgenticClient` only; expose `isImpersonating()` boolean. | S | SEC-D |
| W0-4 | **Sign `BroadcastChannel` messages.** Add HMAC with a per-session secret that other tabs can derive (`sessionSecret` already exists; just generate by default). | S | SEC-E |
| W0-5 | **Hash PHI in `BroadcastChannel` channel name.** SHA-256 the composite ID before constructing the channel. | S | H-6 (vox) |
| W0-6 | **Implement consultation-job HTTP controller.** Add `GET/PATCH/SSE /consultations/jobs/:jobId*` mapping to the existing `ConsultationJobService`. | S | GAP-01 |
| W0-7 | **Fix voice-embedding endpoint mismatch.** Either add `/users/:userId/voice-embedding` to API or rewrite the SDK hook against `/voice-profile/*`. Use `postFormData` for upload. | M | GAP-02, R-02 |
| W0-8 | **Fix user-settings CRUD mismatch.** Reduce SDK surface to `list()` and `updateByKey(namespace,key,value)`. | S | GAP-03, R-03 |
| W0-9 | **Fix pipeline validate path.** Rename API route to `validate` or update `PIPELINE_ENDPOINTS.VALIDATE` to `validate-yaml`. | S | GAP-05, R-04 |
| W0-10 | **Fix role user-management prefix.** Add `/admin/` prefix to `ROLE_ENDPOINTS.USER_ROLES`. | S | GAP-04, R-05 |
| W0-11 | **Map HTTP 403 to `FORBIDDEN`, 429 to `RATE_LIMITED`.** Add codes to `AgenticErrorCode`. | S | R-07, R-10 |
| W0-12 | **Pin model `revision` on med-ner pipelines.** Add `revision` field to `MODEL_MAP`, pass to `pipeline()`. Document SHA-pinned overrides for vad/stt CDN paths. | S | §5 (med-ner) |
| W0-13 | **Stop logging full `DebugTranscriptEntry` to console.** Route through `SDKLogger` so PHI redaction applies. | S | M-4 (stt), R-14 (vox) |

### Wave 1 — Correctness fixes (4 weeks)

These eliminate silent failure modes and resource leaks.

| ID | Action | Effort | Source |
|---|---|:---:|---|
| W1-1 | **Unify `useArca.startAudio` with `useArcaAudio`.** Make `useArca.audio.start` a thin proxy. Eliminate raw `new AudioContext()` and missing `track.stop()`. | M | C-1, C-2 (vox), R-1 (vox) |
| W1-2 | **StrictMode-safe `AudioContextManager`.** Distinguish setup/teardown phases; first effect cleanup must not close the context if a remount is imminent. Add a "disposed" flag. | M | CRITICAL-1 (room) |
| W1-3 | **Remove `createLocalTracks` raw `AudioContext`.** Require caller to pass a context, or route through `AudioContextManager`. | S | CRITICAL-2 (room) |
| W1-4 | **Set `trackRef.current` before `initialize()` in `useAudioTrack`.** Prevent unmount-mid-init leak. | S | HIGH-4 (room) |
| W1-5 | **Map `OverconstrainedError` / `AbortError` / `SecurityError` from `getUserMedia`.** | S | HIGH-1 (room) |
| W1-6 | **Fix `handleTrackEnded` cleanup.** Call `stop()` internally so unplug events free the analyser interval and source node. | S | HIGH-2 (room) |
| W1-7 | **`resumeWithTimeout` race fix.** After `Promise.race`, check `state !== 'running'` and set up click handler unconditionally. | S | HIGH-3 (room) |
| W1-8 | **Pre-allocate WASM buffers in RNNoise.** Call `malloc` once after `rnnoise_create` and reuse. Cache `Float32Array` views. Eliminates 200 heap round-trips/sec. | M | CRIT-1 (noise-filter) |
| W1-9 | **Fix RNNoise output gap (CRIT HIGH-1).** Switch to a one-frame-delay double-buffer scheme so output is never silence. | M | HIGH-1 (noise-filter) |
| W1-10 | **Fix `RNNoiseProcessor.processFrame` typing bug.** `@jitsi/rnnoise-wasm` returns a `Float32Array`, not a number. Current code discards denoised output. | S | HIGH-5 (noise-filter) |
| W1-11 | **Replace `ScriptProcessorNode` in `@arcaai/stt` with `AudioWorkletNode`.** Reuse the pattern in `@arcaai/vad` / `@arcaai/noise-filter`. | M | C-3 (stt) |
| W1-12 | **Use transferable `Float32Array` in Whisper worker `postMessage`.** Pass `[audio.buffer]` as the second arg. | S | C-2 (stt) |
| W1-13 | **Wire `prompt` through the local STT path.** Add `prompt` to `LocalProviderConfig`; pass `initial_prompt` to Transformers.js in both `WhisperEngine.transcribe` and the worker. | S | C-1 (stt) |
| W1-14 | **Replace WhisperWorker linear reconnect with exponential + full jitter, plus a `destroyed` flag.** | S | H-6 (stt) |
| W1-15 | **Reset Silero LSTM hidden state between sessions.** Expose `restart()` on `VADProcessor`. | S | H-1 (vad) |
| W1-16 | **Sliding-window average for VAD probability stats.** Replace unbounded accumulator with a 1000-sample circular buffer. | S | H-2 (vad) |
| W1-17 | **Move `med-ner` inference to a Web Worker.** Mirror the pattern in `@arcaai/stt`. | L | C-1 (med-ner) |
| W1-18 | **Use `aggregation_strategy: 'simple'` for med-ner pipeline.** Eliminates manual `##` stripping and re-merging. | S | H-6 (med-ner) |
| W1-19 | **Tokenizer-aware chunking in med-ner.** Replace `text.slice` with `tokenizer.encode`-based chunk boundaries. | M | C-2 (med-ner) |
| W1-20 | **Fix `ParallelPipeline.cancel` and `executeWithTimeout`.** Use `AbortSignal.timeout` + `AbortSignal.any`; thread the merged signal into `onExecute`. | M | C-1, C-2, H-1 (pipeline) |
| W1-21 | **Implement `autoExecute` data-flow in `PipelineOrchestrator`.** Capture the source result in `handlePipelineCompleted` and call `targetPipeline.execute(...)`. | S | H-4 (pipeline) |
| W1-22 | **Store named listener references in orchestrator `register`.** Remove on `unregister` to prevent listener leaks. | S | L-7 (pipeline) |

### Wave 2 — Performance and DX (8 weeks)

| ID | Action | Effort | Source |
|---|---|:---:|---|
| W2-1 | **Migrate `agenticStore.ts` to Zustand 5 slices + vanilla store + Context provider.** Use atomic selectors in every hook (`useArca`, `useArcaAudio`, …). | XL | P-1 (vox), §2 (research) |
| W2-2 | **Memoize `getLogger` child loggers.** One `child` per hook lifetime, not per call. Adjust `SDKLogger.child()` to share transports without allocating a new SDKLogger each time. | S | P-2, L-4 (vox) |
| W2-3 | **Soft-bypass disabled processors in `ProcessorPipeline`.** Don't destroy WASM state; reroute audio. | M | MEDIUM-2 (room) |
| W2-4 | **Pre-allocate `Float32Array` in `AudioTrack.updateAudioLevel`.** Eliminates 8 KB/tick allocation. | S | LOW-2 (room) |
| W2-5 | **Replace level-monitor `setInterval` with `requestAnimationFrame`.** Pauses with hidden tabs; tracks display rate. | S | §9 P2-14 (room) |
| W2-6 | **Add `Valibot` runtime validation at the API boundary.** Schemas for `Consultation`, `ContextItem`, `SummaryResponse`, `AuthUser`; wrap `response.json()` in `parse(schema, raw)`. | M | §6 R-6 (vox), §3 (research) |
| W2-7 | **Adopt OpenAPI codegen for SDK types and constants.** Generate from NestJS Swagger output; run in CI. | L | R-12 (cross-ref) |
| W2-8 | **Migrate `tsup` → `tsdown`.** Faster builds, parallel `.d.ts` emission via `isolatedDeclarations`. | M | §10 (research) |
| W2-9 | **Add `react-server` export condition.** Stub that throws a friendly error from RSC. | S | §1 (research) |
| W2-10 | **Backpressure on STT in `TranscriptionPipeline.handleVADEvent`.** Bounded queue (e.g., 2 concurrent), drop-and-emit strategy. | S | P-4 (vox) |
| W2-11 | **Apply `condition_on_previous_text` / sliding-window initial prompt to local Whisper.** Suppress chunk-boundary hallucination. | M | §8.4 (stt), W1-13 |
| W2-12 | **Backend STT prompt forwarding.** `RemoteSTTProvider` already plumbs `prompt`; verify backend (`apps/stt-v2`) consumes it for biasing. | S | §6 (stt) |
| W2-13 | **Move `localProviderPool` from static field to per-Provider scope.** Avoid cross-test and cross-instance contamination. | S | H-4 (stt) |
| W2-14 | **Implement `processingMode` in noise-filter** (or remove option). | S | LOW-3 (noise-filter) |
| W2-15 | **Self-host RNNoise WASM and Silero ONNX assets.** Default to bundled files; document optional CDN override. | M | CRIT-2 (noise-filter), C-1 (vad) |

### Wave 3 — 2026 best-practice adoption (12 weeks)

These items track the §9 research findings. Most are P1 by the agent's recommendation but require larger architectural shifts.

| ID | Action | Effort | Source |
|---|---|:---:|---|
| W3-1 | **Whisper-large-v3-turbo with WebGPU + fp16 encoder + q4 decoder.** Add to model map; default for capable devices. | M | §4 (research) |
| W3-2 | **Three-tier runtime detection.** WebGPU → WASM-SIMD → WASM. Emit `runtimeDetected` event at SDK init. | M | §11 (research) |
| W3-3 | **Replace Silero VAD with TEN-VAD.** 87% smaller, lower RTF, better speech-to-non-speech transition. | L | §5 (research) |
| W3-4 | **Replace RNNoise with DeepFilterNet3.** Better noise suppression in clinical environments. Keep RNNoise as low-bandwidth fallback. | L | §6 (research) |
| W3-5 | **Per-user VAD threshold calibration.** 5-second ambient sample at first session; persist in encrypted IndexedDB or OPFS. | S | §5 (research) |
| W3-6 | **AudioWorklet ↔ Worker SharedArrayBuffer ringbuffer for STT.** Eliminate copies between processor stages. Gate on `crossOriginIsolated`. | XL | §7 (research), §6.2 (room) |
| W3-7 | **Replace med-ner BERT with GLiNER-BioMed.** Zero-shot, much smaller, better F1; runs via `@lmoe/gliner-onnx`. Drop community-account models from default map. | L | §8 (research), §9.10 (med-ner) |
| W3-8 | **Apply `useActionState` and `useOptimistic` to streaming transcript hooks.** Reduce boilerplate; allow optimistic UI for partial transcripts. | M | §1 (research) |
| W3-9 | **OPFS for model weight caching and personalization data.** Migrate from Cache API / localStorage. | M | §12 (research) |
| W3-10 | **Resumability tokens on the STT WebSocket.** Server issues `resumeToken`; client replays since `lastSeq` after reconnect. | M | §13 (research) |
| W3-11 | **HIPAA audit-event emission from SDK.** `{ type, timestamp, durationMs, retainedRaw }` events that consumers can forward to their audit trail. | M | §12 (research) |
| W3-12 | **Per-user LoRA adapters (S2-LoRA pattern).** Small sidecar, cloud-trained, loaded into Whisper at runtime. Optional, opt-in. | XL | §9 (research) |

### 5.5 Dependencies between waves

```
W0 (security & API drift)  ──┐
                              ├──► W2 (perf + DX) ─► W3 (adoption)
W1 (correctness)         ────┘
```

Wave 0 and Wave 1 can run in parallel across separate teams (Wave 0 mostly backend + auth + observability; Wave 1 mostly SDK + audio packages). Wave 2 cannot start until W1-2 (StrictMode-safe context) and W1-11 (AudioWorklet STT capture) are merged because both invalidate previous behavioral assumptions used by hooks. Wave 3 depends on the COOP/COEP rollout (W3-2/W3-6) which itself requires aligning with the platform's security headers — coordinate with the API gateway team.

---

## 6. Verification Strategy

For each remediation, captured evidence must include:

- **Tests written before the fix** that reproduce the defect (see §7 of every detail file for gap-by-gap test inventory).
- **Build evidence**: `pnpm build --filter=<package>` actual output for every modified package.
- **Lint evidence**: `pnpm lint --filter=<package>` actual output.
- **Browser smoke tests** (Playwright suites already exist for `room`, `vad`, `stt`, `noise-filter`, `med-ner`) — extended to cover the StrictMode mount/unmount cycle, real `getUserMedia` permission flow, and 30-minute soak runs to expose memory growth.
- **Lighthouse / `web-vitals`** captures for bundle size and TTI on a representative consumer app (`apps/ui-playground`) before and after each merged Wave.

The acceptance criteria for the entire ticket are:

1. Every Wave-0 item is merged with passing tests and a security-team sign-off.
2. The SDK ↔ API matrix in `08-api-cross-reference.md` shows zero red items.
3. Bundle size of `@arcaai/vox/core` decreases by ≥10 % (valibot dead-code removal + slice-pattern store) — measured via `size-limit`.
4. P95 transcription latency on the playground for a 30 s clip on Apple M-series with WebGPU does not regress; ideally improves with W3-1.
5. Med-NER inference on a 1000-character clinical paragraph does not block the main thread for >50 ms (currently 800–2000 ms).

---

## 7. Implementation Summary

This section will be filled in as Wave 0/1 PRs merge. The file table below tracks the planned changes. No code is being written under this assessment ticket — sub-tickets per wave will reference back here.

### 7.1 Files expected to change in Wave 0

| File | Change | Wave-0 ID |
|---|---|---|
| `packages/agentic-sdk-v2/src/core/SSEClient.ts` | Switch to ticket-based auth | W0-1 |
| `apps/api/src/auth/*` | Add `/auth/stream-ticket` endpoint, accept ticket in `JwtAuthGuard` | W0-1 |
| `packages/agentic-sdk-v2/src/logger/transports/highlight.transport.ts` | Hash PHI fields | W0-2 |
| `packages/agentic-sdk-v2/src/logger/SDKLogger.ts` | Apply redact list to `user` context | W0-2 |
| `packages/agentic-sdk-v2/src/auth/AgenticClient.ts` | Hold impersonation token internally; new code mappings | W0-3, W0-11 |
| `packages/agentic-sdk-v2/src/store/agenticStore.ts` | Drop `authOriginalToken` field | W0-3 |
| `packages/agentic-sdk-v2/src/sync/SimpleCrossTabSync.ts` | HMAC sign messages, hash channel name | W0-4, W0-5 |
| `apps/api/src/modules/consultation/*` | New `ConsultationJobController` | W0-6 |
| `apps/api/src/modules/voice-profile/*` & `packages/agentic-sdk-v2/src/hooks/useVoiceEmbedding.ts` | Path alignment + multipart upload | W0-7 |
| `apps/api/src/modules/user/controllers/user-settings.controller.ts` & SDK `useUserSettings.ts` | Surface reduction | W0-8 |
| `apps/api/src/modules/pipeline/audio-pipeline.controller.ts` | Path rename | W0-9 |
| `packages/agentic-sdk-v2/src/core/constants.ts` | `ROLE_ENDPOINTS.USER_ROLES` prefix | W0-10 |
| `packages/agentic-sdk-v2/src/types/common.ts` | Add `FORBIDDEN`, `RATE_LIMITED` codes | W0-11 |
| `packages/med-ner/src/types/index.ts` & `MedNERProcessor.ts` | Pin model `revision` | W0-12 |
| `packages/agentic-sdk-v2/src/transports/SttV2WebSocketClient.ts` | Route debug log through `SDKLogger` | W0-13 |

### 7.2 Cross-cutting test additions

A new shared test helper package, `tests/helpers/audio-strictmode/`, should be created to exercise StrictMode mount/cleanup/remount cycles for all audio hooks. This will be reused across `room`, `vad`, `stt`, `noise-filter`, and `vox` test suites.

---

## 8. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | Architecture team (review session) | Initial assessment — nine parallel deep reviews + cross-API audit + 2026 best-practice research. Status set to **Review**. |
| 2026-05-23 | Wave-0 implementer agents (A1–A11) | Eleven parallel implementer subagents dispatched with non-overlapping write scopes and locked contract decisions D1–D9. Each ticket landed strict TDD with build/test/lint gates. Child tickets created: [TASK-263](../TASK-263-Backend-API-Drift/README.md) (backend API drift), [TASK-264](../TASK-264-SDK-Auth-Core/README.md) (SDK auth core), [TASK-265](../TASK-265-SDK-Endpoint-Drift/README.md) (SDK endpoint drift), [TASK-266](../TASK-266-SDK-Observability-PHI/README.md) (SDK observability + PHI), [TASK-267](../TASK-267-useArca-Audio-Unification/README.md) (`useArca` audio unification), [TASK-268](../TASK-268-Room-Core-Fixes/README.md) (`@arcaai/room` core), [TASK-269](../TASK-269-NoiseFilter-Critical/README.md) (`@arcaai/noise-filter` critical), [TASK-270](../TASK-270-STT-Critical/README.md) (`@arcaai/stt` critical), [TASK-271](../TASK-271-VAD-Cleanup/README.md) (`@arcaai/vad` cleanup), [TASK-272](../TASK-272-MedNER-Worker/README.md) (`@arcaai/med-ner` worker offload), [TASK-273](../TASK-273-Pipeline-Correctness/README.md) (`@arcaai/pipeline` correctness). |
| 2026-05-23 | Synthesis pass | A mid-run `git stash` incident during A2 (TASK-264) silently reverted ~80 source-file modifications across A3/A5/A6/A7/A8/A9/A10/A11 to HEAD while preserving the agents' new files. Recovery executed by replaying the dropped stash (commit `d4f68c12`, `git fsck --lost-found`) on a clean tree, then overlaying A2/A4 post-stash final state from a safety branch. **Final cross-package gate (all packages, post-recovery):** `@arcaai/api` 1028/1028 ✓, `@arcaai/vox` 2730/2730 ✓ (115 files), `@arcaai/room` 483/483 ✓, `@arcaai/vad` 198/198 ✓, `@arcaai/stt` 306/306 ✓, `@arcaai/noise-filter` 166/166 ✓, `@arcaai/med-ner` 139/139 ✓, `@arcaai/pipeline` 158/158 ✓ — **5208 tests passing across the 8 packages, 0 lint errors**. Wave-0 status set to **Completed**. |
| 2026-05-23 | Synthesis pass — Wave-1 follow-ups recorded | Out-of-scope items deferred to Wave 1: (a) `apps/ui-playground/.../voice-embedding-panel.tsx` rewrite against the new `useVoiceEmbedding.enroll/list/delete` shape (D2); (b) `packages/agentic-sdk-v2/src/hooks/useConsultationJob.ts` migration to the new `SSEClient(scope, apiClient, logger)` constructor; (c) `AUTH_ENDPOINTS.STREAM_TICKET` constant addition + replacing the inlined `TICKET_ENDPOINT` in `SSEClient.ts`; (d) `packages/agentic-sdk-v2/src/hooks/useSTT.ts` realignment to the current `STTProcessor` API (pre-existing typecheck errors); (e) `R-05` reconciliation — `ROLE_ENDPOINTS.USER_ROLES` URL `/users/:id/roles` vs API `/admin/users/:id/roles` (A3 left unchanged per TASK-265 contract); (f) med-ner `H-2` `mergeAdjacentEntities` count-aware weighted-average score fix; (g) med-ner Playwright E2E fixture refresh against the new `createMedNER({ workerFactory })` API; (h) extending `isAllowedToActivate` gating pattern to `LokiTransport` and `OTelTransport`; (i) cross-browser-tab HMAC strategy (current per-session secret defends same-process attackers; true cross-tab needs SharedWorker or derived key). |
| 2026-05-23 | Wave-1A implementer agents (B1–B5) | Five parallel implementer subagents dispatched with non-overlapping write scopes, closing follow-ups (a)–(d), (f), (g), (h) above. Each ticket landed with strict TDD, build/test/lint/ReadLints gates, and an isolated ticket README. Child tickets created: [TASK-274](../TASK-274-SDK-SSE-Auth-Alignment/README.md) (B1 — `AUTH_ENDPOINTS.STREAM_TICKET` constant + `SSEClient.ts` swap + `useConsultationJob.ts` constructor migration), [TASK-275](../TASK-275-Playground-Voice-Profile-Migration/README.md) (B2 — `voice-embedding-panel.tsx` rewrite to `enroll`/`list`/`delete` + 12 new component tests), [TASK-276](../TASK-276-STT-useSTT-Realignment/README.md) (B3 — `packages/stt/src/hooks/useSTT.ts` lock-in tests pinning the post-A8 `STTProcessor` surface; source already aligned), [TASK-277](../TASK-277-MedNER-Correctness-Fixes/README.md) (B4 — `mergeAdjacentEntities` count-aware weighted-average rewrite + 4 RED-first tests + Playwright E2E fixture refreshed to `createMedNER({ workerFactory })`), [TASK-278](../TASK-278-Logger-Transport-Gating/README.md) (B5 — `LokiTransport` + `OTelTransport` `static isAllowedToActivate` + `permanentlyDisabled` fail-closed gating, mirroring `HighlightTransport`, +5 RED-first tests per transport). |
| 2026-05-23 | Wave-1A synthesis pass | **Final cross-package gate (all packages, post-Wave-1A):** `@arcaai/api` 1028/1028 ✓, `@arcaai/vox` 2744/2744 ✓ (115 files; +14 over Wave-0 baseline from B1+B5 lock-in tests), `@arcaai/room` 483/483 ✓, `@arcaai/vad` 198/198 ✓, `@arcaai/stt` 316/316 ✓ (+10 from B3 lock-in tests), `@arcaai/noise-filter` 166/166 ✓, `@arcaai/med-ner` 143/143 ✓ (+4 from B4 weighted-avg tests), `@arcaai/pipeline` 158/158 ✓; `@arcaai/ui-playground` build ✓ (+12 component tests from B2). **5236 tests passing across the 8 packages (+28 vs Wave-0 baseline of 5208), 0 lint errors.** Wave-1A status: **Completed**. Remaining open items now consolidated under Wave-1B: (e) R-05 ROLE_ENDPOINTS split → [TASK-279](../TASK-279-ROLE-Endpoints-Split/README.md); (i) cross-tab HMAC via SharedWorker → [TASK-280](../TASK-280-CrossTab-HMAC-SharedWorker/README.md); plus newly-discovered (j) [TASK-281](../TASK-281-MedNER-E2E-Infra/README.md) — med-ner Playwright E2E infra (http-server can't serve `dist/` outside its root, `serve.json` COOP/COEP headers ignored), and (k) SDK type-drift surfaced by B2 in `@arcaai/vox/core.ts` (`AgenticActions` / `AgenticState` not exported, `level` missing on `LokiTransportConfig` / `OTelTransportConfig`, `secureStorage.ts` `Uint8Array<ArrayBuffer*>` mismatches, `SSEConnectOptions.authToken` unset, `kind` missing on `AudioProcessorOptions`) and `@arcaai/ui` subpath imports (`tsconfig` vs `package.json#exports` mismatch — Vite has `resolveArcaUiSubpaths` workaround, tsc does not). |
| 2026-05-24 | Wave-1B implementer agents (B6, B7) | Two parallel implementer subagents dispatched with non-overlapping write scopes. Each landed with strict TDD, build/test/lint/ReadLints gates, and an isolated ticket README. Child tickets created: [TASK-279](../TASK-279-ROLE-Endpoints-Split/README.md) (B6 — R-05 `ROLE_ENDPOINTS` split: `USER_ROLES` user-self surface + new `ADMIN_USER_ROLES_ENDPOINTS` admin-RBAC block at `/admin/users/:id/roles[/:assignmentId]`, second-arg semantic rename `roleId → assignmentId` in `useRoles.ts`, three new admin methods `listUserRoleAssignments`/`assignRoleToUser`/`removeUserRoleAssignment`, deprecated aliases retained with `useRef`-backed one-shot `console.warn`); [TASK-280](../TASK-280-CrossTab-HMAC-SharedWorker/README.md) (B7 — `SimpleCrossTabSync` HMAC via SharedWorker: new `CrossTabHmacSharedWorker.ts` worker entry owning the 32-byte secret + new `CrossTabHmacKeyManager.ts` client manager wrapping `new SharedWorker(...)` with sign/verify/reset RPC, 500ms RPC timeout, per-session fallback when SharedWorker is unavailable; `SimpleCrossTabSync` now delegates HMAC to the manager; new `isUsingSharedWorkerHmac()` diagnostic accessor — closes the original deficiency that the per-session module singleton couldn't verify across tab processes). |
| 2026-05-24 | Wave-1B synthesis pass | **Final cross-package gate (all packages, post-Wave-1B):** `@arcaai/api` 1028/1028 ✓, `@arcaai/vox` 2779/2779 ✓ (117 files; +35 over Wave-1A baseline — B6 added 19, B7 added 16), `@arcaai/room` 483/483 ✓, `@arcaai/vad` 198/198 ✓, `@arcaai/stt` 316/316 ✓, `@arcaai/noise-filter` 166/166 ✓, `@arcaai/med-ner` 143/143 ✓, `@arcaai/pipeline` 158/158 ✓; `@arcaai/ui-playground` build ✓. **5271 tests passing across the 8 packages (+35 vs Wave-1A baseline of 5236, +63 vs Wave-0 baseline of 5208), 0 lint errors** (13 pre-existing prettier warnings outside Wave-1B scope). Wave-1B status: **Completed**. **Newly-discovered Wave-2 items:** (l) **TASK-282 (proposed)** — backend lacks `GET /admin/users/:id/roles` listing and end-user `GET /users/:id/roles` route (B6 surfaced — `listUserRoleAssignments` will 404 today, end-user "my roles" is currently served only by `/auth/me.roles`); (m) re-export `ADMIN_USER_ROLES_ENDPOINTS` from `packages/agentic-sdk-v2/src/core.ts` root barrel (mechanical, B6 left out of write scope); (n) **154 pre-existing `pnpm typecheck` errors in `@arcaai/vox`** (B7 surfaced — NodeNext `.js` extension drift in test imports, `Uint8Array<ArrayBufferLike>` widening in `secureStorage.ts`, missing `vi` import in `impersonation-config.test.ts`, plus the `core/index.ts:37` re-export of non-existent `type CrossTabEvent` — Vitest is green because esbuild does not gate on `tsc`; suggest a dedicated typecheck-cleanup ticket); (o) cosmetic `SharedConnectionManager` constructor `workerUrl?: string` should broaden to `string \| URL` to match the new `CrossTabHmacKeyManager` signature. |

---

## 9. Appendix — How to read the per-package files

Each `0N-*.md` file follows the same structure:

1. **Architecture** — what the package contains, how it loads, lifecycle.
2. **Public API** — table of every export with stability marker.
3. **Strengths** — confirmed good designs.
4. **Defects** — split into Critical / High / Medium / Low, each with `file:line` citations.
5. **Security** — package-specific HIPAA/CSP/SAB concerns.
6. **Performance** — allocations, hot paths, latency budgets.
7. **Test coverage gaps** — table of uncovered behaviours.
8. **Conformance to best practices** — gap analysis vs the 2026 baseline in `09-best-practices-2026.md`.
9. **Refactor / improvement suggestions** — concrete patches, often with code blocks.

The cross-reference file (`08-api-cross-reference.md`) follows a slightly different structure: an endpoint coverage matrix, a drift catalog, an auth-flow validation, a real-time channel validation, and an error-contract conformance summary, ending with a numbered list of recommendations referenced from this README.

The research file (`09-best-practices-2026.md`) is a survey of 13 areas — React 19, Zustand 5, Valibot, Whisper-large-v3-turbo, TEN-VAD, DeepFilterNet3, AudioWorklet+SAB, GLiNER-BioMed, personalization, tsdown, WebGPU matrix, HIPAA patterns, WebSocket reconnect — each with priority markers (P1/P2/P3) used by §5 above.
