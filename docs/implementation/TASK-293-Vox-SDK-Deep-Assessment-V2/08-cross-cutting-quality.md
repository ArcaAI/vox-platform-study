# 08 — Cross-Cutting Quality & 2026 Best-Practice Adoption

**Reviewer**: A8 (cross-cutting). **Scope**: 7 packages. **Anchor**: TASK-262 §09 + §2 scorecards. Per-package defects are owned by A1–A7; this report only covers cross-cutting patterns.

## 1. Method (≤4 lines)

Read each package's `package.json`, `tsup.config.ts`, `tsconfig.json`, store / barrel, and worklets (file-level). Grepped for `useActionState`, `useOptimistic`, `useShallow`, `createStore`, `forwardRef`, `SharedArrayBuffer`, `crossOriginIsolated`, `OPFS`, `valibot`, `whisper-large-v3-turbo`, `revision`, `resumeToken`, `tsdown`, `isolatedDeclarations`, model strings. No long-running shells; no `tsc --noEmit` runs (cost-blocked). Test counts taken from `__tests__/` directory listings.

## 2. Per-package quality matrix

| Pkg | Build (tsup.config) | Entry / exports | Types | Tests (unit / e2e) | Top-level deps | React 19 readiness | Perf hot-path | Sec / pinning |
|---|---|---|---|---|---|---|---|---|
| `@arcaai/vox` | `tsup`; `splitting:false`; `dts:false` (manual `.d.ts`); 4 entries (index/core/plugins/plugins-med-ner) + e2e; `treeshake:true`; banner `"use client"` ✓ (`tsup.config.ts:84-99`) | `import:./dist/*.mjs`, `require:./dist/*.js`; **no `react-server` cond.**; `sideEffects:false` ✓ (`package.json:8-43`) | Manual `.d.ts`; no `isolatedDeclarations`; `lib:["ES2015","DOM"…]` (low bar) (`tsconfig.json:6`) | 126 unit / 1 e2e spec | 5 (`valibot`, `zustand`, `eventemitter3`, `deepmerge-ts`, `diff`) + 4 workspace plugins | `"use client"` via banner; `useAgenticStore()` whole-store subs everywhere — **no atomic selectors / `useShallow`** (`hooks/useArca*.ts`) | Whole-store re-render storm; `valibot` parsed once at boot (`ConfigManager.ts:206`) | No SRI; no model SHA pinning |
| `@arcaai/room` | `tsup`; `dts:true`; single entry; `target:'es2022'`; `treeshake:true`; **no `"use client"` banner** (`tsup.config.ts`) | `import:./dist/index.js` (not `.mjs`); **no `sideEffects` flag**; **no `react-server`** (`package.json:9-15`) | DTS auto; `verbatimModuleSyntax:true` ✓; no isolated decls (`tsconfig.json`) | 19 unit / 1 e2e | `eventemitter3` only | Exports React hooks (`useAudioTrack`, `useDevices`, `useAudioMixer`) but **no `"use client"` directive** ⚠ — RSC consumers will fail | Each `MediaStream*Node` boundary copies (TASK-262 §4.2) | n/a (no model loading) |
| `@arcaai/vad` | `tsup`; `dts:true`; single entry; `external:['@ricky0123/vad-web','onnxruntime-web']`; **no `"use client"`** (`tsup.config.ts`) | `import:./dist/index.js`; **no `sideEffects` flag**; no `react-server` (`package.json:9-15`) | DTS auto; no isolated decls | 9 unit / 1 e2e | `@ricky0123/vad-web@^0.0.30` (one) | Exports `useVAD` but **no `"use client"`**; defines `isCrossOriginIsolated()` helper ✓ (`utils/browserSupport.ts:64`) | **`new Float32Array(this.frameBuffer)` per frame on audio thread** (`worklets/vad.worklet.ts:131`) — hot-path alloc ⚠ | CDN load of Silero ONNX + worklet bundle from jsDelivr without SRI (constants.ts:40,49) |
| `@arcaai/stt` | `tsup`; `dts:true`; main + worker entries; banner `"use client"` ✓ on main only (`tsup.config.ts:27-31`); worker bundles `@huggingface/transformers` ✓ | `import:./dist/index.mjs` ✓, `require:./dist/index.js` ✓; **no `sideEffects:false`** until line 24 wait — actually has it ✓ (`package.json:24`); no `react-server` (`package.json:8-19`) | DTS auto; no isolated decls; `tsconfig.json` standalone (not extending shared) | 17 unit / 1 e2e | `@huggingface/transformers@3.8.1` + `onnxruntime-web` pinned to `1.22.0-dev.20250409-89f8206ba4` (dev tag in prod ⚠) | Banner OK; worker uses `device:'webgpu'`+fp16 ✓ (`engines/WhisperEngine.ts:81-86`) | Whisper hard-coded to `tiny/base/small/medium/large` (no `whisper-large-v3-turbo`); `decoder_model_merged:'fp16'` (recommendation: `q4`) | No `revision` SHA on `pipeline()`; HF Hub fetched live |
| `@arcaai/noise-filter` | `tsup`; `dts:true`; main + worklet entries; copies `rnnoise.wasm` to `dist/assets/` ✓ (`tsup.config.ts:46-48`); **no `"use client"` banner** | `import:./dist/index.js`; `./worklet` and `./wasm` subpath exports ✓; **no `sideEffects` flag** (worklet has side-effects, so `false` would be wrong; needs explicit array) (`package.json:9-21`) | DTS auto; no isolated decls | 13 unit / 1 e2e | `@jitsi/rnnoise-wasm@^0.2.1` (one) | Exports `useNoiseFilter` but **no `"use client"`** | Pre-allocated WASM buffers ✓ + output ring buffer ✓ (`worklets/rnnoise.worklet.ts:60-79`) — best-engineered worklet in the stack | WASM now ships in package ✓ (CRIT-2 fixed in TASK-269) |
| `@arcaai/med-ner` | `tsup`; `dts:true`; main + worker + e2e bundles; banner `"use client"` ✓ (`tsup.config.ts:42`); worker bundles transformers ✓ | `import:./dist/index.js`; `./worker` subpath ✓; **no `sideEffects` flag**; no `react-server` (`package.json:9-19`) | DTS auto; no isolated decls | 11 unit / 1 e2e | `@huggingface/transformers@^3.8.1` (caret — drift risk) | Banner OK | Worker offload now present (post-TASK-262 C-1 fix); not yet GLiNER-BioMed | No `revision`; community accounts (`Kushtrim/`, `samrawal/`) |
| `@arcaai/pipeline` | `tsup`; `dts:true`; single entry; **no target**; **no `"use client"`** (no React, OK) (`tsup.config.ts`) | `import:./dist/index.js`; **no `sideEffects` flag**; no `react-server` (`package.json:9-15`) | DTS auto; no isolated decls | 5 unit / 1 e2e | `eventemitter3` only | n/a (no React) | n/a | n/a |

## 3. Cross-cutting defects (Critical / High only — file:line)

- **C-XCUT-1 (High)** — `room`, `vad`, `noise-filter` ship React hooks **without `"use client"`** boundaries (no banner in `tsup.config.ts`; no source-level directive). RSC consumers (Next 15 / App Router) will silently bundle these on the server tree and crash on first `AudioContext`/`MediaStream` reference. (`packages/room/tsup.config.ts:1-15`, `packages/vad/tsup.config.ts:7-19`, `packages/noise-filter/tsup.config.ts:32-49`).
- **C-XCUT-2 (High)** — **No `react-server` export condition on any of the 7 packages.** RSC graphs cannot import safely; no friendly throw-stub. (`packages/{vox,room,vad,stt,noise-filter,med-ner,pipeline}/package.json#exports`). Anchor §1, §10.
- **C-XCUT-3 (High)** — Exports map drift: 5 of 7 packages publish `import:./dist/index.js` (CJS-style filename) instead of `.mjs`. Only `@arcaai/vox` and `@arcaai/stt` use the `.mjs`/`.cjs` split; bundlers occasionally mis-resolve to CJS. (`packages/{room,vad,noise-filter,med-ner,pipeline}/package.json:9-15`).
- **C-XCUT-4 (High)** — `room`, `vad`, `noise-filter`, `med-ner`, `pipeline` lack `"sideEffects": false`. This blocks deep tree-shaking when imported via `@arcaai/vox`'s plugins entry; tsup's `treeshake:true` only helps inside the bundle. (`packages/{room,vad,noise-filter,med-ner,pipeline}/package.json`). Anchor §10.
- **C-XCUT-5 (High)** — `vox` store uses `create<…>(…)` (singleton) at module scope (`packages/agentic-sdk-v2/src/store/agenticStore.ts:294`). Not SSR-safe; no per-request isolation; no Context provider; no `useShallow` anywhere. Whole-store subscriptions are the largest perf defect (TASK-262 §4.5; confirmed: `useAgenticStore()` called without selector in `useArcaSession.ts:65`, `useArca.ts:283`, etc.).
- **C-XCUT-6 (High)** — `onnxruntime-web` pinned to `1.22.0-dev.20250409-89f8206ba4` in `@arcaai/stt` (`packages/stt/package.json:57-58`); `@arcaai/vad` peer pulls `1.24.3` ABI; `vad` constants pin yet another version (`1.22.0`) on its CDN URL (`packages/vad/src/constants.ts:49`). Triple version skew across the audio path — runtime breakage on any minor bump. Anchor §11.
- **C-XCUT-7 (High)** — No package adopts `useActionState` / `useOptimistic`. Streaming-transcript hook (`useArca.audio-pipeline`) hand-rolls partial-vs-final state with `useState` only. No `Suspense`-compatible `createResource()` factory. Anchor §1.
- **C-XCUT-8 (High)** — `vad/worklets/vad.worklet.ts:131` allocates a fresh `Float32Array(this.frameBuffer)` **on every accumulated frame** on the audio render thread, then transfers via `postMessage` (line 134). RNNoise worklet shows the correct pattern (pre-allocated). No SAB ringbuffer anywhere in the stack despite `crossOriginIsolated()` helper. Anchor §7.
- **C-XCUT-9 (Critical)** — No package emits HIPAA audit-events from the SDK pipeline. `useAuditLog` (vox) only reads server logs; the on-device pipeline (capture / VAD / STT / NER) emits none. (`packages/agentic-sdk-v2/src/hooks/useAuditLog.ts`). Anchor §12.
- **C-XCUT-10 (High)** — STT WS reconnect uses **half-jitter** (`Math.random() * exponentialDelay * 0.5`) and **no resumability tokens / lastSeq replay** (`packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts:384-386`). Token pre-refresh missing. Anchor §13.

## 4. 2026 best-practice adoption matrix (15 rows)

| # | Practice | TASK-262 priority | Status | Evidence |
|---|---|---|---|---|
| 1 | React 19 `useActionState` / `useOptimistic` | P1/P2 | **Not yet** | grep across `packages/*/src` returns 0 hits |
| 2 | Zustand 5 vanilla `createStore()` + Context + atomic selectors / `useShallow` | P1 | **Not yet** | `agenticStore.ts:8,294` uses `create()`; `useShallow` 0 hits; whole-store reads in `useArca.ts:283`, `useArcaSession.ts:65` |
| 3 | Valibot at API boundary | P1 | **Partial** | Used for SDK config only (`ConfigManager.ts:206`, `ConfigSchema.ts`); event payloads + WS messages still untyped at runtime |
| 4 | Whisper-large-v3-turbo + WebGPU + fp16/q4 | P1 | **Partial** | WebGPU+fp16 ✓ (`engines/WhisperEngine.ts:81-86`); model IDs limited to `tiny..large` (`engines/BaseEngine.test.ts:271-281`); no `turbo`; decoder also fp16 (not q4) |
| 5 | TEN-VAD | P1 | **Not yet** | `package.json:63` still `@ricky0123/vad-web` (Silero) |
| 6 | DeepFilterNet3 | P1 | **Not yet** | `package.json:66` still `@jitsi/rnnoise-wasm` |
| 7 | SharedArrayBuffer ringbuffer between worklets | P1 | **Not yet** | grep `SharedArrayBuffer` only inside detection helpers (`*/utils/browserSupport.ts`); no SAB-backed buffer; `MessageStream*Node` copies persist |
| 8 | GLiNER-BioMed | P2 | **Not yet** | `med-ner` still on token-classification BERT (TASK-262 §4.3); model registry has no GLiNER entries |
| 9 | Per-user VAD calibration | P1 | **Not yet** | grep `calibrateVAD\|noise floor\|RMS noise` returns 0 hits in `packages/vad/src` |
| 10 | OPFS for model weights | P2 | **Not yet** | `navigator.storage` only used for quota estimate (`packages/utils/src/ModelManagementService.ts:349`); no `getDirectory()` calls |
| 11 | Resumability tokens on STT WS | P1 | **Not yet** | `SttV2WebSocketClient.ts:357-389` uses bare `attemptReconnect`; no `resumeToken`/`lastSeq` round-trip |
| 12 | HIPAA audit-event emission from SDK pipeline | P2 | **Not yet** | `useAuditLog` reads server log only; capture/VAD/STT/NER emit no audit events |
| 13 | Per-user LoRA adapters | P2 | **Not yet** | `PersonalizationManager` is scaffolding (TASK-262 §3.7); no LoRA download/cache path |
| 14 | OpenAPI codegen for SDK constants | P1 | **Not yet** | `core/constants.ts` hand-maintained; no generator in `package.json` scripts |
| 15 | tsup → tsdown migration | P1 | **Not yet** | All 7 `tsup.config.ts` files; `tsup@^8.5.1` in every devDeps |

**Adoption rough estimate: ~7%** (1 partial × 0.5 + 1 partial × 0.5 + 0 fully adopted out of 15 = ~1/15).

## 5. Top-5 cross-cutting must-fix (P0 → P2)

| Rank | Item | Tag | Effort | Anchor |
|---|---|---|---|---|
| 1 | Refactor `agenticStore` to vanilla `createStore()` + Context + slices + atomic selectors. Replace every `useAgenticStore()` no-selector call with `(s => s.field)` (or `useShallow`). Single biggest perf + SSR fix. | **P0** | M | §2 |
| 2 | Add `"use client"` directive (source-level or banner) to `room`, `vad`, `noise-filter`. Add `react-server` export condition that throws a friendly error in all 7 packages. Add `sideEffects: false` (or explicit array for worklet entries) to the 5 missing packages. | **P0** | S | §1, §10 |
| 3 | Pin `onnxruntime-web` to one stable version across `vox`, `stt`, `vad` (`vad` CDN URL too). Stop using `1.22.0-dev.*` dev tag in production deps. | **P0** | S | §11 |
| 4 | Add resumability tokens + full-jitter (`Math.random() * cappedDelay`) + token pre-refresh to `SttV2WebSocketClient`. Add `lastSeq`/replay handshake on reconnect. | **P1** | M | §13 |
| 5 | Migrate `tsup → tsdown` and enable `isolatedDeclarations` once across the seven packages. Schedule `useActionState`+`createResource()` exposure for the next iteration. | **P1** | M | §10 |

## 6. Consolidated scorecard

| Package | Architecture | Correctness | Security | Performance | Test coverage | Best-practice fit |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `@arcaai/vox` | B+ | C+ | C− | C | B− | C− |
| `@arcaai/room` | B | C+ | C+ | C+ | C+ | C |
| `@arcaai/vad` | C | C− | C− | C− | C− | C− |
| `@arcaai/stt` | B− | C+ | C | B− | C+ | C |
| `@arcaai/noise-filter` | B− | B− | C+ | B | C+ | C+ |
| `@arcaai/med-ner` | C+ | C+ | C+ | C+ | C− | C− |
| `@arcaai/pipeline` | B− | C+ | n/a | B− | C+ | C+ |

(Letter scale: A excellent, B good, C acceptable with material issues, D poor, F unacceptable. Slightly lower than TASK-262 §2.5 where post-TASK-269/-271 fixes have landed but cross-cutting 2026 patterns remain unadopted.)

## 7. Notes & blockers (≤120 words)

- **Did not run** `tsc --noEmit` per package (cost). Type-quality conclusions inferred from `tsconfig.json` settings + visible `as any` density (`vox` has the highest at 100+ test files; `room/EventEmitter.ts:4`, `med-ner/processors/MedNERProcessor.ts:2`, `stt/whisper.worker.ts:1` use `any` in production paths).
- **A1–A7 own** all package-local defects (sample-rate enforcement, RNNoise glitches, dead vad worklet, med-ner Worker, etc.); not duplicated here.
- **`valibot` cross-cut**: TASK-262 §3.3 flagged `valibot` as bundled-but-unused; current evidence shows one runtime call (`ConfigManager.ts:206`). Re-classified as **Partial**, not Dead.
- **Open question for owner**: should `@arcaai/pipeline` consume `react-server` and `"use client"` policy at all (no React)? Recommend explicit `"sideEffects": false` regardless.
