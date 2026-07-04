# TASK-269 — `@arcaai/noise-filter` Critical Fixes

| Field | Value |
|---|---|
| Ticket | TASK-269 |
| Parent | TASK-262 (Vox SDK Deep Assessment) |
| Type | bugfix + refactor |
| Status | Completed |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Scope | `packages/noise-filter/**` (exclusive) |

---

## 1. Requirement Analysis

This ticket addresses five blocking defects identified by the deep assessment in
[`docs/implementation/TASK-262-Vox-SDK-Deep-Assessment/05-noise-filter.md`](../TASK-262-Vox-SDK-Deep-Assessment/05-noise-filter.md):

| Item | Severity | Defect |
|---|---|---|
| **CRIT-1** | Critical | `malloc`/`free` called per 480-sample frame on the audio thread |
| **CRIT-2** | Critical | Default WASM source is a hard-coded jsDelivr CDN URL |
| **CRIT-3** | Critical | Hand-rolled `WebAssembly.instantiate` with the wrong import object for `@jitsi/rnnoise-wasm@0.2.1` |
| **HIGH-1** | High | Output frame gap (silence) at every RNNoise frame boundary |
| **HIGH-5** | High | `process()` type signatures lose `Float32Array<ArrayBuffer>` precision under TS strict |

### Business Context

The noise filter runs on every audio frame inside a real-time audio thread for
every consultation. The combination of CRIT-1 (allocator churn 200×/s) and HIGH-1
(audible silence boundary) produces clicks/crackles in the recorded speech that
downstream STT mis-transcribes. CRIT-2/CRIT-3 make the filter *silently fail*
in restricted-CSP environments (hospital networks) and on the LinkError path,
returning untreated audio to the SDK. HIGH-5 propagates incorrect types to SDK
consumers, masking integration bugs at compile time.

### Acceptance Criteria

- **CRIT-1**: `module._malloc` is called exactly twice per processor lifetime
  (once for input pointer, once for output pointer) — verified by a perf/leak
  test running 10 000 frames after init.
- **CRIT-2**: Default WASM URL no longer references `cdn.jsdelivr.net`. The
  binary is shipped from `dist/assets/rnnoise.wasm`, resolvable from both ESM
  (`import.meta.url`) and CJS (`require.resolve` fallback). Exported via
  `package.json` `exports['./wasm']` so consumers can self-host.
- **CRIT-3**: `RNNoiseProcessor` instantiates the WASM through the upstream
  Emscripten loader (`createRNNWasmModule`) bundled in `@jitsi/rnnoise-wasm`.
  The worklet path uses a minimal hand-port of the same loader pinned to the
  binary's actual import names — verified by a smoke test that drives a
  real-WASM round-trip from Node `fs`.
- **HIGH-1**: A ring-buffer feeds output samples to the audio thread with a
  one-frame (10 ms) priming latency, after which the output is gapless for
  input quantum sizes 256, 480, 512 and 1024 — verified by deterministic
  unit tests.
- **HIGH-5**: `process(input, output)` signatures use
  `Float32Array<ArrayBufferLike>`; internal WASM-backed buffers use the
  narrower `Float32Array<ArrayBuffer>`. Consumers calling `process()` with
  either an `AudioWorklet` quantum or a `ScriptProcessorNode` buffer compile
  under TS 5.9 strict.

---

## 2. Current State Evaluation

### Code reviewed (read-only)

| File | Issue |
|---|---|
| `src/processors/RNNoiseProcessor.ts` | CRIT-1 main, CRIT-3, HIGH-5 |
| `src/worklets/rnnoise.worklet.ts` | CRIT-1 worklet, HIGH-1, CRIT-3, HIGH-5 |
| `src/worklets/worklet-loader.ts` (inline string) | CRIT-1 worklet, HIGH-1, CRIT-3 |
| `src/processors/NoiseFilterProcessor.ts` | CRIT-2 (`https://cdn.jsdelivr.net/...`) |
| `src/rnnoise-wasm.d.ts` | Fictional `Rnnoise.load()` API; upstream exposes `createRNNWasmModule` |
| `src/types/index.ts` | `RNNoiseResult.samples: Float32Array` (HIGH-5) |
| `tsup.config.ts` | Does not copy `@jitsi/rnnoise-wasm/dist/rnnoise.wasm` into our `dist/` |
| `package.json` | No `./wasm` subpath export, `assets/` not in `files` |

### Upstream package contract (`@jitsi/rnnoise-wasm@0.2.1`)

- Entry point `index.js` exports `createRNNWasmModule` (async) and
  `createRNNWasmModuleSync` (base64-embedded).
- `createRNNWasmModule({ wasmBinary })` returns a `Module` with
  `_rnnoise_create`, `_rnnoise_destroy`, `_rnnoise_process_frame`,
  `_malloc`, `_free`, `HEAPF32`.
- The binary's actual import object is `{ a: { a: _emscripten_resize_heap,
  b: _emscripten_memcpy_big } }`. Memory is **exported** (not imported);
  the current `env.memory` injection is silently ignored.
- The binary exports symbols under minified single-letter names; the
  upstream loader is the only safe way to dereference them by their public
  names.

### Downstream blast radius

- `packages/agentic-sdk-v2/src/external-modules.d.ts` only declares the
  high-level `createNoiseFilter()` shape — unaffected.
- `packages/agentic-sdk-v2/tsup.config.ts` includes
  `@arcaai/noise-filter` in `noExternal` (bundled). Asset copy must keep
  the resolved WASM URL valid after vox bundling — we use
  `new URL('./assets/rnnoise.wasm', import.meta.url)` which esbuild +
  Vite resolve to a content-addressed asset path.

### Dependencies

| Package | Purpose | Notes |
|---|---|---|
| `@jitsi/rnnoise-wasm@^0.2.1` | RNNoise WASM binary + Emscripten loader | Already declared |
| `@arcaai/room` (peer) | `createWorkletLoader`, `BaseProcessor` | Consumed only; not modified |

### Baseline test/build state (before changes)

- `pnpm --filter @arcaai/noise-filter test` → 140 tests passing.
- `pnpm --filter @arcaai/noise-filter build` → success (33 KB ESM, 35 KB CJS, 6 KB worklet).
- `pnpm --filter @arcaai/noise-filter lint` → 0 errors (ESLintRC deprecation warning is pre-existing).

---

## 3. Implementation Plan

### 3.1 TDD test list

| Test file | Item | Test cases |
|---|---|---|
| `__tests__/upstreamLoader.test.ts` | CRIT-3 | (a) `createRnnoiseModule({wasmBinary})` returns adapter with `rnnoise_create/process_frame/destroy/malloc/free/heapF32`. (b) Smoke test loads real `@jitsi/rnnoise-wasm/dist/rnnoise.wasm` via Node `fs`, processes 480 zero samples, asserts no throw and returned VAD ∈ [0,1]. (c) Manual worklet loader path: same smoke test using the hand-port loader. |
| `__tests__/preallocation.test.ts` | CRIT-1 | (a) RNNoiseProcessor: spy module factory; after `init()`, `_malloc` called exactly twice; after 10 000 `process()` calls, still exactly twice. (b) Same for the manual worklet loader. (c) `destroy()` calls `_free` twice. |
| `__tests__/wasmAsset.test.ts` | CRIT-2 | (a) `getDefaultWasmUrl()` does not contain `cdn.jsdelivr.net`. (b) URL is resolvable to a readable file in Node. (c) `NoiseFilterProcessor.loadWasmBinary` uses `getDefaultWasmUrl()` when no override. |
| `__tests__/ringBuffer.test.ts` | HIGH-1 | (a) For input sizes 256/480/512/1024 fed continuously, output length per call equals input length. (b) After the priming frame (≤ 480 samples), output contains no zero-only quantum until the stream ends. (c) Trailing partial frame at flush is zero-padded to its full size. |
| `__tests__/processorTypes.test.ts` | HIGH-5 | Type-level assertions via `expectTypeOf`: `process` accepts `Float32Array<ArrayBuffer>` and returns `Float32Array<ArrayBufferLike>`. |

Existing test files (`RNNoiseProcessor.test.ts`, `NoiseFilterProcessor.test.ts`)
are updated to reflect the new no-CDN default, the upstream loader contract,
and the ring buffer behaviour.

### 3.2 File creation/modification order

1. **Plan + ticket README** (this file).
2. RED tests: `upstreamLoader.test.ts`, `preallocation.test.ts`,
   `wasmAsset.test.ts`, `ringBuffer.test.ts`, `processorTypes.test.ts`.
3. New types: replace `src/rnnoise-wasm.d.ts` with the correct
   `createRNNWasmModule` ambient declaration.
4. New module: `src/processors/rnnoiseModule.ts` — adapter exposing
   `RnnoiseModule` (uniform interface) backed by `createRNNWasmModule`
   on the main thread.
5. New utility: `src/utils/wasmAsset.ts` — `getDefaultWasmUrl()`.
6. Refactor: `src/processors/RNNoiseProcessor.ts` — preallocate buffers,
   delegate WASM lifecycle to `rnnoiseModule.ts`, implement ring buffer,
   tighten `process()` typing.
7. Refactor: `src/worklets/rnnoise.worklet.ts` — preallocate buffers,
   implement ring buffer, replace WASM imports with the
   binary's actual import object.
8. Refactor: `src/worklets/worklet-loader.ts` — keep inline string in
   strict sync with the worklet TS source (same algorithm, plain JS).
9. Refactor: `src/processors/NoiseFilterProcessor.ts` — use
   `getDefaultWasmUrl()`; drop the CDN URL.
10. Build glue: `tsup.config.ts` — `onSuccess` copies
    `@jitsi/rnnoise-wasm/dist/rnnoise.wasm` into `dist/assets/rnnoise.wasm`.
11. `package.json` — add `./wasm` and `./assets/*` subpath exports,
    include `assets` in `files`.
12. Barrel exports: `src/utils/index.ts`, `src/index.ts`.
13. Update legacy tests (`RNNoiseProcessor.test.ts`,
    `NoiseFilterProcessor.test.ts`) for the new API.
14. Verification gate.

### 3.3 Verification criteria

- All five RED tests transition to GREEN.
- `pnpm --filter @arcaai/noise-filter test` → all tests passing (existing 140 + new).
- `pnpm --filter @arcaai/noise-filter build` → success, `dist/assets/rnnoise.wasm` present.
- `pnpm --filter @arcaai/noise-filter lint` → 0 errors.
- `pnpm --filter @arcaai/vox build` → success (consumer smoke check).
- `ReadLints` on every modified file → no new diagnostics.

### 3.4 Out of scope (deferred)

The following items from `05-noise-filter.md` are **not** addressed by this
ticket and are left for follow-up tickets (per A7 instructions): HIGH-2, HIGH-3,
HIGH-4, HIGH-6, all MED-* and LOW-*. In particular, the dual-source maintenance
trap (MED-8) persists — the inline `generateWorkletSource()` is updated
**by hand** to match the TS source for the items in scope.

---

## 4. Implementation Summary

### 4.1 What was built

| Item | Resolution |
|---|---|
| **CRIT-1** | `RNNoiseProcessor.init()` and the worklet's `initWasm()` both allocate `inputPtr` and `outputPtr` exactly once via `malloc(480*4)`. The audio-thread hot path (`process()` / `processRNNoiseFrame()`) reuses these pointers; `destroy()` frees them once. The new `preallocation.test.ts` spies on `_malloc`/`_free` across 10 000 process calls and asserts the call count never moves after init. |
| **CRIT-2** | The hard-coded `cdn.jsdelivr.net` default is removed. `getDefaultWasmUrl()` returns `new URL('../assets/rnnoise.wasm', import.meta.url)` (works in both `src/` and bundled `dist/index.js`). `tsup`'s `onSuccess` copies `@jitsi/rnnoise-wasm/dist/rnnoise.wasm` into both `<pkg>/assets/rnnoise.wasm` and `<pkg>/dist/assets/rnnoise.wasm` on every build. `package.json` adds the `./wasm` and `./assets/rnnoise.wasm` subpath exports and the `assets` `files` entry so consumers can `import wasmUrl from '@arcaai/noise-filter/wasm?url'` or self-host the binary. |
| **CRIT-3** | `RNNoiseProcessor` delegates instantiation to the official upstream loader (`createRNNWasmModule({ wasmBinary })`) via the new `processors/rnnoiseModule.ts` adapter. The worklet — which cannot `import` at runtime — uses `processors/workletRnnoiseLoader.ts`, a minimal hand-port of the same Emscripten runtime pinned to the binary's actual import object (`{ a: { a: resize_heap, b: memcpy_big } }`) and its stable single-letter exports. The previous `rnnoise-wasm.d.ts` (which described a fictional `Rnnoise.load()` API) is replaced with the real `createRNNWasmModule` declaration. A real-WASM smoke test in `upstreamLoader.smoke.test.ts` (and the equivalent in `workletRnnoiseLoader.test.ts`) drives both loaders against `@jitsi/rnnoise-wasm/dist/rnnoise.wasm` loaded via Node `fs`. |
| **HIGH-1** | Both processors now use a 2×480 ring buffer with one frame of priming latency. After the first `processFrame()` runs, the consumer never sees a zero-sample gap regardless of input quantum size. The new `ringBuffer.test.ts` parametrises sizes 256, 480, 512 and 1024 and asserts (a) per-call sample counts, (b) gap-free output after priming, and (c) monotonicity from a strictly-increasing input signal. |
| **HIGH-5** | `RNNoiseResult.samples` and the `process(input, output)` argument types use `Float32Array<ArrayBufferLike>`; the internal WASM-backed views use the narrower `Float32Array<ArrayBuffer>`. A `expectTypeOf` regression test (`processorTypes.test.ts`) pins both ends of the contract. |

### 4.2 Files changed

| File | Change |
|---|---|
| `packages/noise-filter/src/processors/rnnoiseModule.ts` | **NEW** — `createRnnoiseModule(...)` upstream-loader adapter (CRIT-3). |
| `packages/noise-filter/src/processors/workletRnnoiseLoader.ts` | **NEW** — `instantiateRnnoiseInWorklet(...)` minimal hand-port for the AudioWorklet thread (CRIT-3). |
| `packages/noise-filter/src/processors/RNNoiseProcessor.ts` | Preallocation, ring buffer, upstream loader, tightened types (CRIT-1, CRIT-3, HIGH-1, HIGH-5). |
| `packages/noise-filter/src/processors/NoiseFilterProcessor.ts` | Use `getDefaultWasmUrl()` (CRIT-2); pass the WASM binary into `RNNoiseProcessor.init()` (CRIT-3). |
| `packages/noise-filter/src/wasmAsset.ts` | **NEW** — `getDefaultWasmUrl()` (CRIT-2). |
| `packages/noise-filter/src/rnnoise-wasm.d.ts` | Replaced fictional `Rnnoise.load()` types with the real `createRNNWasmModule(...)` signature (CRIT-3). |
| `packages/noise-filter/src/worklets/rnnoise.worklet.ts` | Preallocation, ring buffer, correct WASM import object & export names (CRIT-1, CRIT-3, HIGH-1, HIGH-5). |
| `packages/noise-filter/src/worklets/worklet-loader.ts` | Inline `generateWorkletSource()` mirrors the same algorithm (kept manually in sync; MED-8 deferred). |
| `packages/noise-filter/src/types/index.ts` | `RNNoiseResult.samples: Float32Array<ArrayBufferLike>` (HIGH-5). |
| `packages/noise-filter/src/index.ts` | Re-export `getDefaultWasmUrl`. |
| `packages/noise-filter/tsup.config.ts` | `onSuccess` copies the bundled WASM into `assets/` and `dist/assets/` (CRIT-2). |
| `packages/noise-filter/package.json` | `./wasm` and `./assets/rnnoise.wasm` subpath exports; `assets` added to `files` (CRIT-2). |
| `packages/noise-filter/assets/rnnoise.wasm` | **NEW (binary)** — bundled RNNoise WASM (112 141 bytes; identical to `@jitsi/rnnoise-wasm@0.2.1/dist/rnnoise.wasm`). |
| `packages/noise-filter/src/__tests__/upstreamLoader.test.ts` | **NEW** — `createRnnoiseModule` unit tests (mocked factory). |
| `packages/noise-filter/src/__tests__/upstreamLoader.smoke.test.ts` | **NEW** — real-WASM round-trip via the upstream loader. |
| `packages/noise-filter/src/__tests__/workletRnnoiseLoader.test.ts` | **NEW** — real-WASM round-trip via the manual worklet loader. |
| `packages/noise-filter/src/__tests__/preallocation.test.ts` | **NEW** — 10 000-frame allocator-call-count assertions. |
| `packages/noise-filter/src/__tests__/wasmAsset.test.ts` | **NEW** — `getDefaultWasmUrl` + processor default-URL assertions. |
| `packages/noise-filter/src/__tests__/ringBuffer.test.ts` | **NEW** — parametrised ring-buffer behaviour for 256/480/512/1024. |
| `packages/noise-filter/src/__tests__/processorTypes.test.ts` | **NEW** — `expectTypeOf` checks on `process()` signature. |
| `packages/noise-filter/src/__tests__/RNNoiseProcessor.test.ts` | Updated two existing `init` tests for the new mandatory `wasmBinary` argument. |

### 4.3 Asset bundling for SDK consumers

Downstream packages that bundle `@arcaai/noise-filter` (`@arcaai/vox`,
applications using the SDK directly) have three options for the WASM
binary:

1. **Default (zero-config)**: leave `wasmPath` unset.
   `NoiseFilterProcessor.loadWasmBinary()` calls `getDefaultWasmUrl()`,
   which expands to `new URL('../assets/rnnoise.wasm', import.meta.url)`.
   Modern bundlers (Vite ≥ 3, webpack 5, esbuild, Rollup ≥ 4) recognise
   this pattern and emit `assets/rnnoise.wasm` to the consumer's
   output directory automatically.
2. **Self-hosted override**: pass an explicit `wasmPath` to
   `createNoiseFilter({ wasmPath: '/static/rnnoise.wasm' })`. Useful for
   apps with their own asset CDN.
3. **Direct subpath import**: `import wasmUrl from '@arcaai/noise-filter/wasm'`
   (or `?url` in Vite/webpack) returns the bundled `assets/rnnoise.wasm`
   URL; pass that to `wasmPath` for full control.

The previous default — a `cdn.jsdelivr.net` URL — is gone. There is no
runtime third-party dependency for the WASM binary anymore.

### 4.4 Verification

#### Tests (166 passing)

```
Test Files  13 passed (13)
     Tests  166 passed (166)
  Duration  ~1.6 s
```

26 new tests added across `upstreamLoader.test.ts`,
`upstreamLoader.smoke.test.ts`, `workletRnnoiseLoader.test.ts`,
`preallocation.test.ts`, `wasmAsset.test.ts`, `ringBuffer.test.ts`,
`processorTypes.test.ts`. All 140 pre-existing tests still pass
(2 updated to reflect the new `init()` signature).

#### Build

```
ESM dist/worklets/rnnoise.worklet.js     6.36 KB
ESM dist/index.js                        34.50 KB
CJS dist/index.cjs                       36.27 KB
DTS dist/index.d.ts                      21.41 KB
DTS dist/index.d.cts                     21.41 KB
dist/assets/rnnoise.wasm                 112 141 bytes
```

#### Lint

`pnpm --filter @arcaai/noise-filter lint` → 0 errors, 0 warnings
(ESLintRC deprecation notice unchanged; pre-existing across the repo).

#### Downstream smoke

`pnpm --filter @arcaai/vox build` → success
(`dist/index.mjs` 5.41 MB, no new diagnostics).

### 4.5 Deviations from the original plan

- **No standalone `src/ringBuffer.ts` module**: the ring-buffer logic is
  short enough that extracting it into a separate file would have
  added an import surface without test value. The logic is now inlined
  inside `RNNoiseProcessor.processFrame()` and the worklet's
  `processRNNoiseFrame()`. Tests exercise it through the public
  `process()` API.
- **Two diverging worklet sources remain** (`rnnoise.worklet.ts` and the
  inline `generateWorkletSource()` string in `worklet-loader.ts`).
  MED-8 from the parent assessment recommends a single source via
  `?raw` import; that work is out of scope for this ticket and tracked
  separately. The two sources were updated *in lockstep*.

### 4.6 Out of scope / follow-up

These items from `05-noise-filter.md` are **not** addressed by TASK-269
and should be triaged into follow-up tickets:

| Item | Severity | Title |
|---|---|---|
| HIGH-2 | High | `initWasm()` async error swallowed |
| HIGH-3 | High | Blob URL never revoked when worklet re-registers |
| HIGH-4 | High | `RNNoiseProcessor` hidden dynamic properties (removed in this ticket as a side-effect of the rewrite, but the broader anti-pattern audit is not done) |
| HIGH-6 | High | `initScriptProcessorFallback()` race between async `init` and `onaudioprocess` |
| MED-1 … MED-11 | Medium | Sample-rate validation, VAD gating, hardcoded stats, dual listener, etc. |
| LOW-1 … LOW-8 | Low | ScriptProcessor latency, dead `processingMode`, etc. |

---

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-05-23 | Ticket opened; plan drafted. | `README.md` |
| 2026-05-23 | RED tests for all five items committed (16 failing assertions). | `src/__tests__/{upstreamLoader,preallocation,wasmAsset,ringBuffer,processorTypes}.test.ts` |
| 2026-05-23 | GREEN implementation: upstream loader adapter, manual worklet loader, preallocated buffers, ring buffer, bundled WASM asset, tightened types. All 166 tests pass. | (see §4.2) |
| 2026-05-23 | Status → Completed; verification gate passed; vox build smoke-checked. | `README.md` |

