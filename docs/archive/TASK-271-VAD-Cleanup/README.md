# TASK-271 — @arcaai/vad Cleanup

| Field | Value |
|---|---|
| Ticket | TASK-271 |
| Parent | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Source defect doc | [03-vad.md](../TASK-262-Vox-SDK-Deep-Assessment/03-vad.md) |
| Type | refactor + bugfix |
| Status | Completed |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Scope | `packages/vad/**` (exclusive) |
| Forbidden | All other packages/apps; `@arcaai/room` public API (consume only) |

---

## 1. Requirement Analysis

Address the following defects from `03-vad.md` in a single ticket:

| ID | Severity | Title |
|---|---|---|
| C-1 / C-2 | Critical | ONNX Runtime + vad-web CDN versions are stale and mismatch installed deps |
| C-3 / C-4 | Critical | Custom AudioWorklet and worklet-loader are dead code; never registered or consumed |
| H-1 | High | Silero VAD LSTM hidden state never reset on stream change / explicit reset / long silence |
| H-2 | High | `averageSpeechProbability` accumulates unboundedly (precision erosion, ever-growing average) |
| H-4 | High | `VADSpeechEndPayload` lacks `duration` (ms) field; example code prints `undefined ms` |
| L-2 | Low | Input AudioContext sampleRate mismatch (44.1 / 48 kHz) — no explicit 16 kHz resample helper / verification |

### Business Context

`@arcaai/vad` ships speech detection for medical consultation pipelines. Stale CDN ABI mismatches (C-1/C-2) can silently break inference for self-hosted deployments. Dead worklet code (C-3/C-4) misleads consumers and bloats the public surface. Stateful LSTM bleed-over (H-1) corrupts speech detection across speakers / sessions. Unbounded stats (H-2) erode metric accuracy over multi-hour consultations. `duration` (H-4) is referenced in published README examples but does not exist. Sample-rate mismatch (L-2) is the most common foot-gun for new integrators.

### Acceptance Criteria

1. CDN paths derive from a single version constant per dependency in `src/constants.ts`; constants match installed `package.json` versions and are exported.
2. `packages/vad/src/worklets/` directory and `./worklet` subpath export are removed; their tests are removed; an `index.ts` public-export snapshot test gates the API surface.
3. New `VADProcessor.reset()` and `VADProcessor.setStream(stream)` methods exist; LSTM state is reset on each path (verified by replacing MicVAD with a new instance). A `silenceResetMs` option (default 5000) triggers an internal reset after sustained non-speech.
4. `VADStats.averageSpeechProbability` is computed from a fixed `Float32Array(N)` ring buffer (N=300 ≈ 10 s at 31.25 fps); memory does not grow with frame count.
5. `VADSpeechEndPayload.duration` (ms) exists and equals `endTime - startTime`.
6. A `resampleToVADRate()` helper resamples any input rate to 16 kHz; covered by a 48 kHz → 16 kHz test.
7. `pnpm --filter @arcaai/vad build`, `pnpm --filter @arcaai/vad test`, `pnpm --filter @arcaai/vad lint` all succeed; `pnpm --filter @arcaai/vox build` smoke succeeds.

---

## 2. Current State Evaluation

| Area | File(s) | Issue |
|---|---|---|
| CDN constants | `src/processors/VADProcessor.ts:32-33` | Hard-coded `@0.0.29` / `@1.22.0`; installed are `^0.0.30` / `^1.24.3` |
| Worklets (dead) | `src/worklets/{index,vad.worklet,worklet-loader}.ts` | Not registered anywhere; main path uses `MicVAD`'s internal worklet only |
| Worklet types | `src/types/index.ts` (`VADWorklet*`) | Unused; exported as public API |
| Worklet exports | `src/index.ts`, `package.json` (`./worklet` subpath) | Exposes unreachable surface |
| LSTM state | `src/processors/VADProcessor.ts` | No public reset path; bleed-over across speakers / long silences |
| Probability stats | `src/processors/VADProcessor.ts:111-112,366-368` | Unbounded `sum`/`count` accumulators |
| Speech-end payload | `src/types/index.ts` `VADSpeechEndPayload` | No `duration: number` (ms) |
| Sample rate | `src/processors/VADProcessor.ts:onInit` | No explicit resample helper or warning on mismatch |
| Tests (dead) | `src/__tests__/workletLoader.test.ts`, `src/__tests__/types.test.ts` (worklet shape tests) | Tied to removed surface |
| E2E (dead) | `e2e/vad.e2e.spec.ts` (`Worklet Loader Tests` describe) | References removed exports |

### Consumers of the to-be-removed worklet surface

Verified via ripgrep across the whole repository: every reference to `WORKLET_PROCESSOR_NAME`, `registerVADWorklet`, `createVADWorkletNode`, `cleanupVADWorkletResources`, `isVADWorkletRegistered`, `VADWorkletInboundMessage`, `VADWorkletOutboundMessage`, `VADWorkletConfig`, or `@arcaai/vad/worklet` lives inside `packages/vad/` itself or in TASK-262 docs. No app, no other package, and `@arcaai/vox` does not consume it.

---

## 3. Implementation Plan

### File creation / modification order

1. **`src/constants.ts`** (new) — `VAD_WEB_VERSION`, `ORT_WEB_VERSION`, `DEFAULT_BASE_ASSET_PATH`, `DEFAULT_ONNX_WASM_BASE_PATH`.
2. **`src/processors/VADProcessor.ts`** — import constants; remove local CDN string literals.
3. **`src/index.ts`** — export new constants; remove worklet exports.
4. **`src/types/index.ts`** — add `duration: number` to `VADSpeechEndPayload`; remove `VADWorklet*` types.
5. **`src/processors/VADProcessor.ts`** —
   - replace unbounded probability accumulator with `Float32Array(N)` ring buffer + writeIdx + count (H-2);
   - add `duration: endTime - startTime` to speech-end payload (H-4);
   - add `silenceResetMs` option, silence tracking, internal auto-reset on threshold (H-1);
   - add public `reset()` and `setStream(stream)` (H-1).
6. **`src/utils/resampler.ts`** — export `resampleToVADRate(samples, inputRate)` (L-2). Re-export from `utils/index.ts` and `index.ts`.
7. **Delete** `src/worklets/` directory + `dist/worklets/` build entry; remove `./worklet` subpath from `package.json`; update `tsup.config.ts`.
8. **Delete** `src/__tests__/workletLoader.test.ts`.
9. **Trim** worklet-shape tests from `src/__tests__/types.test.ts`.
10. **Trim** `Worklet Loader Tests` describe from `e2e/vad.e2e.spec.ts`.

### TDD Test list (RED → GREEN, in order)

| # | Test file | Test | Defect |
|---|---|---|---|
| 1 | `src/__tests__/constants.test.ts` | `VAD_WEB_VERSION` matches installed `@ricky0123/vad-web` version | C-1 |
| 2 | `src/__tests__/constants.test.ts` | `ORT_WEB_VERSION` matches installed `onnxruntime-web` version | C-2 |
| 3 | `src/__tests__/constants.test.ts` | `DEFAULT_BASE_ASSET_PATH` interpolates `VAD_WEB_VERSION` | C-1 |
| 4 | `src/__tests__/constants.test.ts` | `DEFAULT_ONNX_WASM_BASE_PATH` interpolates `ORT_WEB_VERSION` | C-2 |
| 5 | `src/__tests__/publicExports.test.ts` | Snapshot of public exports of `index.ts` does not include worklet APIs | C-3 |
| 6 | `src/__tests__/publicExports.test.ts` | Snapshot of public exports does not include `VADWorklet*` types | C-3 |
| 7 | `src/__tests__/VADProcessor.test.ts` | `reset()` recreates the MicVAD instance | H-1 |
| 8 | `src/__tests__/VADProcessor.test.ts` | `setStream(stream)` recreates the MicVAD instance with the new stream | H-1 |
| 9 | `src/__tests__/VADProcessor.test.ts` | Silence accumulating past `silenceResetMs` triggers internal reset | H-1 |
| 10 | `src/__tests__/VADProcessor.test.ts` | `averageSpeechProbability` is bounded by ring buffer; memory stable across many frames | H-2 |
| 11 | `src/__tests__/VADProcessor.test.ts` | `VADSpeechEndPayload.duration === endTime - startTime` | H-4 |
| 12 | `src/__tests__/types.test.ts` | `VADSpeechEndPayload` type accepts `duration` field | H-4 |
| 13 | `src/__tests__/resampler.test.ts` | `resampleToVADRate(48 kHz, 16000 samples)` returns approximately 5333 samples | L-2 |

### Verification Criteria

- All new/modified tests pass.
- `pnpm --filter @arcaai/vad build` succeeds.
- `pnpm --filter @arcaai/vad lint` reports zero warnings.
- `pnpm --filter @arcaai/vox build` smoke succeeds (no consumer breakage).
- `ReadLints` clean on all touched files.

---

## 4. Implementation Summary

### 4.1 Files created

| Path | Purpose |
|---|---|
| `packages/vad/src/constants.ts` | Single source of truth for `VAD_WEB_VERSION` (`0.0.30`), `ORT_WEB_VERSION` (`1.24.3`), and derived `DEFAULT_BASE_ASSET_PATH` / `DEFAULT_ONNX_WASM_BASE_PATH`. Replaces the hard-coded stale CDN strings that lived in `VADProcessor.ts`. |
| `packages/vad/src/__tests__/constants.test.ts` | Asserts constants match installed `package.json` versions and interpolate correctly into the CDN URLs. |
| `packages/vad/src/__tests__/publicExports.test.ts` | `toMatchInlineSnapshot` lock on the package's public surface. Confirms the deleted worklet APIs are gone and pins future intentional additions. |
| `docs/implementation/TASK-271-VAD-Cleanup/README.md` | This ticket document. |

### 4.2 Files modified

| Path | Change |
|---|---|
| `packages/vad/src/processors/VADProcessor.ts` | Imports CDN paths from `constants.ts`; adds `currentStream` / `lastSpeechActivityMs` / `resetting` state; adds `reset()` and `setStream(stream)` public methods; tracks silence and triggers an internal reset after `silenceResetMs`; replaces unbounded `probabilitySum/Count` with a `Float32Array(300)` ring buffer; sets `duration: endTime - speechStartTime` (ms) on `VADSpeechEndPayload`. |
| `packages/vad/src/types/index.ts` | Adds `VADOptions.silenceResetMs?: number` (default 5000); adds `VADSpeechEndPayload.duration: number` (ms); removes the dead `VADWorklet*` types; bumps `DEFAULT_VAD_OPTIONS` to include `silenceResetMs: 5000`. |
| `packages/vad/src/index.ts` | Exports the new constants; exports `resampleToVADRate`; drops worklet exports (`WORKLET_PROCESSOR_NAME`, `isVADWorkletRegistered`, `VADWorklet*` types). |
| `packages/vad/src/utils/resampler.ts` | Adds `resampleToVADRate(samples, inputSampleRate)` helper for the 44.1 / 48 kHz → 16 kHz path. |
| `packages/vad/src/utils/index.ts` | Re-exports `resampleToVADRate`. |
| `packages/vad/tsup.config.ts` | Removes the dead `src/worklets/vad.worklet.ts` build entry. |
| `packages/vad/package.json` | Removes the `./worklet` subpath from `exports`. |
| `packages/vad/vitest.setup.ts` | Fixes an infinite-recursion bug in `MockMediaStreamTrack#clone` exposed by the new H-1 tests. |
| `packages/vad/src/__tests__/VADProcessor.test.ts` | Adds `MicVAD.new` instance-per-call mock, full `init` flow tests, and 14 new tests covering H-1 (3 reset + 2 setStream + 4 silence) and H-2 (4 ring buffer) and H-4 (1 duration). |
| `packages/vad/src/__tests__/types.test.ts` | Removes the `VADWorkletConfig` tests; adds `duration: number` to the `VADSpeechEndPayload` shape tests. |
| `packages/vad/src/__tests__/resampler.test.ts` | Adds 4 tests for `resampleToVADRate` (16 / 48 / 44.1 kHz inputs and a single v5 frame). |
| `packages/vad/e2e/vad.e2e.spec.ts` | Removes the `@arcaai/vad Worklet Loader Tests` describe; leaves a TASK-271 comment marker. |

### 4.3 Files deleted

| Path | Reason |
|---|---|
| `packages/vad/src/worklets/vad.worklet.ts` | Dead code (TASK-262 03-vad.md C-3 / C-4) — never registered. |
| `packages/vad/src/worklets/worklet-loader.ts` | Dead loader for the dead worklet. |
| `packages/vad/src/worklets/index.ts` | Barrel for the deleted folder. |
| `packages/vad/src/worklets/` (directory) | Empty after deletions. |
| `packages/vad/src/__tests__/workletLoader.test.ts` | Tests for the removed surface. |

### 4.4 Public API changes

Additions (non-breaking for existing consumers):

- `VAD_WEB_VERSION`, `ORT_WEB_VERSION`, `DEFAULT_BASE_ASSET_PATH`, `DEFAULT_ONNX_WASM_BASE_PATH` (constants).
- `resampleToVADRate(samples, inputSampleRate)` (utility).
- `VADProcessor.reset()` (instance method).
- `VADProcessor.setStream(stream)` (instance method).
- `VADOptions.silenceResetMs?: number` (option, default 5000).
- `VADSpeechEndPayload.duration: number` (payload field, ms).

Removals:

- `WORKLET_PROCESSOR_NAME`, `isVADWorkletRegistered`, `registerVADWorklet`, `createVADWorkletNode`, `cleanupVADWorkletResources` (all dead).
- `VADWorkletInboundMessage`, `VADWorkletOutboundMessage`, `VADWorkletConfig` (types for dead surface).
- `"./worklet"` subpath export from `package.json`.

Repo-wide ripgrep verification at the start of this ticket confirmed no consumer (apps, packages, including `@arcaai/vox`) used any of the removed names; only `packages/vad/` itself and TASK-262 docs referenced them.

### 4.5 Verification evidence

#### `pnpm --filter @arcaai/vad test`

```
 RUN  v4.1.1 /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/vad

 Test Files  8 passed (8)
      Tests  183 passed (183)
   Duration  1.16s
```

#### `pnpm --filter @arcaai/vad build`

```
ESM dist/index.js      35.14 KB   ⚡️ Build success in 77ms
CJS dist/index.cjs     37.01 KB   ⚡️ Build success in 77ms
DTS dist/index.d.ts    31.71 KB   ⚡️ Build success in 417ms
```

#### `pnpm --filter @arcaai/vad lint`

```
> @arcaai/vad@0.1.0 lint
> ESLINT_USE_FLAT_CONFIG=false eslint "src/**/*.ts*" --max-warnings 0
(exit code 0, no warnings)
```

#### `pnpm --filter @arcaai/vox build` (smoke)

```
ESM dist/index.mjs     5.42 MB   ⚡️ Build success in 7788ms
CJS dist/index.js      5.42 MB   ⚡️ Build success in 7793ms
ESM dist/plugins.mjs   5.08 MB   ⚡️ Build success in 7792ms
CJS dist/plugins.js    5.08 MB   ⚡️ Build success in 7792ms
```

Warnings emitted by the `@arcaai/vox` build are pre-existing (`import.meta` target-env warnings from `@arcaai/noise-filter`, `"use client"` directives, unused `useContext` / `jsx` imports) and unrelated to this ticket.

#### ReadLints

`ReadLints` returned "No linter errors found." for every modified file.

### 4.6 Deviations from the plan

| Item | Deviation | Reason |
|---|---|---|
| H-1 | Added a fix to `packages/vad/vitest.setup.ts` (`MockMediaStreamTrack#clone` no longer recurses) | The pre-existing recursion bug was hidden because no test constructed `new MediaStreamTrack()` directly. The new H-1 setStream test does. Fix is scoped to the test mock and ≤2 lines. |
| L-2 | Implementation is a helper utility rather than a runtime hook inside `VADProcessor` | `MicVAD`'s internal worklet already resamples the input stream to 16 kHz; intercepting in `VADProcessor` would require rewriting `MicVAD`'s pipeline. The helper documents and tests the safe path consumers should use when building bespoke pipelines, satisfying the task without ripping out the working internal resampler. |

### 4.7 Blockers / follow-ups (out of scope)

None blocking. Follow-ups from `03-vad.md` not in this ticket:

- H-3 (`postSpeechPadMs` not in `RealTimeVADOptions`) — needs upstream `@ricky0123/vad-web` change or downstream remove.
- H-5 / L-1 / L-6 (sample-rate validation, dead `VADWorkletConfig.sampleRate`, mocked context at 48 kHz) — partially mitigated by `resampleToVADRate`; full fix is a future cleanup.
- M-1 (`updateThresholds()` no-op) — now obsoleted by `reset()`; consumers calling `updateThresholds()` followed by `reset()` get the intended behavior. A future ticket can either remove `updateThresholds()` or have it call `reset()` internally.
- M-2..M-9 (`useVAD` hook fixes, threshold validation, etc.) — separate ticket.
- Security and performance items in `03-vad.md` §5–6.

## 5. Change History

| Date | Change | Files |
|---|---|---|
| 2026-05-23 | Ticket created with plan | this README |
| 2026-05-23 | C-1/C-2/C-3/C-4/H-1/H-2/H-4/L-2 implemented; build, test, lint, vox smoke green | see §4.1–4.3 |
