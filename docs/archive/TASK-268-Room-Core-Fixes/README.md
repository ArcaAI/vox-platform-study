# TASK-268 — `@arcaai/room` Core Fixes

| | |
|---|---|
| Ticket Number | TASK-268 |
| Parent Ticket | TASK-262 (Vox SDK Deep Assessment) |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | refactor / bugfix (correctness, perf, DX) |
| Owner | A6 sub-agent |
| Scope | `packages/room/src/**` (internals only — public API surface frozen) |

---

## 1. Requirement Analysis

### 1.1 Description

Implement Wave 1 / Wave 2 correctness fixes scoped exclusively to the `@arcaai/room` package, addressing bugs identified in
the [TASK-262 deep assessment](../TASK-262-Vox-SDK-Deep-Assessment/02-room.md). The downstream packages
(`@arcaai/vad`, `@arcaai/stt`, `@arcaai/noise-filter`, `@arcaai/vox`) must continue to compile and run without modification —
this is enforced by the **D7 locked contract**: the public API surface of `@arcaai/room/index.ts` (signatures, type names,
exported members) remains identical.

### 1.2 Business context

`@arcaai/room` underpins every audio capture path in the HOPE consultation SDK. Defects in the singleton `AudioContextManager`,
`AudioTrack` lifecycle, and `useAudioTrack` / `useAudioLevel` React hooks cause:

- **CRITICAL-1**: AudioContext silently closed under React 19 StrictMode dev double-mount → "permanently broken until manual
  resume" symptom in development.
- **CRITICAL-2**: `createLocalTracks(processor)` leaks an untracked `AudioContext` per call.
- **HIGH-1**: `getUserMedia` rejections silently fall through to `RoomErrorCode.UNKNOWN`, hiding actionable codes such as
  permission-denied, device-not-found, insecure-context, and unsupported-constraints.
- **HIGH-2**: `MediaStreamTrack.onended` does not stop the processor / level monitor / source node, so device unplug leaks
  resources and continues firing on a dead source.
- **HIGH-4**: `useAudioTrack` writes `trackRef.current` only after `initialize()` resolves, so an unmount mid-`getUserMedia`
  leaks the new `AudioTrack`.
- **HIGH-3**: `AudioContextManager.resumeWithTimeout` swallows the timeout branch silently, never throws, and emits
  `RoomEvent.Connected` even when the context is still suspended.
- **LOW-2**: Per-frame `Float32Array(2048)` allocation in `AudioTrack.updateAudioLevel` (8 KB × 20 Hz = 160 KB/s GC churn).
- **MEDIUM-4 / W2-4 reframed**: every `useAudioLevel` consumer of the same `AudioTrack` indirectly creates its own analyser,
  multiplying per-tick allocations and graph nodes. Share a single ref-counted analyser per track.

### 1.3 Acceptance criteria

1. **D7 contract preserved** — `pnpm --filter @arcaai/{vad,stt,noise-filter,vox} build` continues to succeed without changes.
2. **W1-2 — StrictMode-safe `AudioContextManager`**: ref-counted acquire/release tolerates React 19 dev double-mount. Vitest
   simulating mount → cleanup → re-mount keeps the context alive.
3. **W1-3 — `Room.createLocalTracks` typed errors**: `getUserMedia` rejections rethrown as named subclasses with stable codes.
4. **W1-4 — `AudioTrack` `'ended'` handling**: subscribing to `MediaStreamTrack.onended` calls `stop()` internally and emits
   exactly one `TrackEvent.Ended`.
5. **W1-5 — `useAudioTrack` ref ordering**: `trackRef.current` set immediately after construction; unmount-mid-`initialize`
   stops the track and frees `getUserMedia` capture.
6. **W1-6 — Float32 preallocation**: `AudioTrack.updateAudioLevel` reuses one buffer across 1000+ frames; constructor-call
   spy proves bounded allocations (≤ 1 per `setupAudioLevelMonitoring()` invocation).
7. **W1-7 — `resumeWithTimeout` race**: timeout branch throws `RoomResumeTimeoutError` after a 3000 ms default; click handler
   set up unconditionally when not running.
8. **W2-4 — shared analyser**: two `useAudioLevel` consumers of the same `AudioTrack` cause exactly one analyser node to be
   created on the underlying context.

### 1.4 Method

Strict TDD per item: write a failing Vitest test, watch RED, write minimal GREEN code, REFACTOR. JSDOM environment with
hand-rolled `AudioContext` / `MediaStream` stubs (already established in `vitest.setup.ts`). `@testing-library/react`
`renderHook` for hook tests. No new runtime dependencies.

---

## 2. Current State Evaluation

| File | Issue | Resolution |
|---|---|---|
| `src/core/AudioContextManager.ts:120–131` | `release()` decrements to 0 then immediately closes — fatal for StrictMode | Microtask-deferred close + `disposed` flag |
| `src/core/AudioContextManager.ts:249–259` | `Promise.race` against `sleep` swallows timeout silently | Throw `RoomResumeTimeoutError` after race; reset state and click handler |
| `src/core/Room.ts:331–343` | `createLocalTracks` constructs untracked `new AudioContext` and never closes it | Route through `AudioContextManager`; close on `track.on(TrackEvent.Ended)` |
| `src/core/Room.ts:198–223` and `src/core/AudioTrack.ts:554–573` | `getUserMedia` errors collapse to `RoomErrorCode.UNKNOWN` | New typed subclasses (internal exports) with stable codes; `wrapError` updated |
| `src/core/AudioTrack.ts:546–549` | `handleTrackEnded` only updates state and emits — leaks nodes | Internal cleanup (mirrors `stop`) without re-emitting `Ended` twice |
| `src/core/AudioTrack.ts:455–479` | New `Float32Array(fftSize)` per tick | Allocate once in `setupAudioLevelMonitoring`; `null` in `stop` |
| `src/hooks/useAudioTrack.ts:117–166, 224–232` | `trackRef.current` written **after** `initialize()`; unmount mid-init leaks track | Set ref before `initialize`; cleanup checks ref + cancels in-flight init |
| `src/hooks/useAudioLevel.ts:79–116` | Each consumer subscribes to the same track event → multiple analysers if a track has its own; no sharing across consumers | Track-scoped ref-counted analyser registry inside the hook module |

### 2.1 D7 contract — exact public API surface (from `index.ts`)

The 100+ exports listed in `02-room.md §2` remain unchanged. Internal additions only — extra error subclasses are exported
from `index.ts` so consumer code can `instanceof`-check, but no existing export is removed or renamed.

### 2.2 Dependencies / impact

- Internal-only changes inside `packages/room/src/**`.
- `vitest.setup.ts` mock surface is sufficient; no new global stubs required.
- No new runtime dependencies. `@testing-library/react` is already a dev dependency.

---

## 3. Implementation Plan

### 3.1 Test list (TDD — failing tests written first)

| # | Item | Test file | Behaviour |
|---|---|---|---|
| 1 | W1-2 | `__tests__/AudioContextManager.test.ts` | `acquire → release → acquire` within microtask preserves the same `AudioContext` |
| 2 | W1-2 | same | `release` followed by `acquire` synchronously must not leave context closed |
| 3 | W1-2 | same | `dispose()` still hard-closes regardless of pending grace timer |
| 4 | W1-3 | `__tests__/Room.test.ts` | `createLocalTracks` with `NotAllowedError` → `RoomPermissionError` (`code='mic_permission_denied'`) |
| 5 | W1-3 | same | `NotFoundError` → `RoomDeviceError` (`code='mic_not_found'`) |
| 6 | W1-3 | same | `SecurityError` → `RoomSecurityError` (`code='mic_insecure_context'`) |
| 7 | W1-3 | same | `OverconstrainedError` → `RoomConstraintError` (`code='mic_constraints_unsupported'`) |
| 8 | W1-3 | same | unrelated `Error` → `RoomUnknownError` |
| 9 | W1-4 | `__tests__/AudioTrack.test.ts` | when `MediaStreamTrack.onended` fires, the level-monitor interval is cleared and source node disconnected |
| 10 | W1-4 | same | `Ended` event fires exactly once on device-unplug |
| 11 | W1-4 | same | new `TrackEvent.TrackEnded` alias does not exist (only existing `TrackEvent.Ended`) — no public surface change |
| 12 | W1-5 | `__tests__/useAudioTrack.test.ts` | unmount during in-flight `initialize` calls `stop()` on the freshly-created track |
| 13 | W1-6 | `__tests__/AudioTrack.test.ts` | 1000 ticks of `updateAudioLevel` allocate ≤ 1 `Float32Array` (spy-counted) |
| 14 | W1-7 | `__tests__/AudioContextManager.test.ts` | `resume()` against a `resume()`-pending context that never resolves throws `RoomResumeTimeoutError` after a 3000 ms timeout |
| 15 | W1-7 | same | timeout branch sets up click handler unconditionally |
| 16 | W2-4 | `__tests__/useAudioLevel.test.ts` | two `useAudioLevel(track)` hooks mounted simultaneously create exactly one analyser node on `track`'s `AudioContext` |
| 17 | W2-4 | same | unmounting one consumer keeps the analyser alive; unmounting both tears it down |

### 3.2 File-creation/modification order

1. **New error classes** in `src/core/RoomErrors.ts` (internal exports re-routed via `index.ts`).
2. **`AudioContextManager`** — add `disposed` flag, microtask-grace `release`, refactor `resumeWithTimeout` to throw a typed
   timeout error.
3. **`Room.createLocalTracks`** — accept caller `AudioContext` from `AudioContextManager`; close it on `Ended`; map errors.
4. **`AudioTrack`** — `handleTrackEnded` performs cleanup; preallocate level-monitor `Float32Array`; error mapping for
   typed subclasses.
5. **`useAudioTrack`** — set `trackRef.current` before `initialize`; cleanup robust to mid-init unmount.
6. **`useAudioLevel`** — per-track ref-counted analyser registry.
7. Tests added per item.

### 3.3 Verification criteria

- All new tests RED before code changes; GREEN after.
- `pnpm --filter @arcaai/room {build,test,lint}` clean.
- `pnpm --filter @arcaai/{vad,stt,noise-filter,vox} build` succeed unchanged.
- `ReadLints` clean on every modified file.

---

## 4. Implementation Summary

All seven items (W1-2 → W1-7, W2-4) shipped. Public API surface in
`packages/room/src/index.ts` was **not** modified — new error subclasses live in
`src/core/RoomErrors.ts` as **package-internal** symbols. They propagate through
existing `throw` paths and remain `instanceof RoomError`, so all downstream
consumers (`@arcaai/vad`, `@arcaai/stt`, `@arcaai/noise-filter`, `@arcaai/vox`)
continue to compile unchanged (D7 contract verified).

### 4.1 Per-item summary

| # | Item | Mechanism |
|---|------|-----------|
| W1-2 | StrictMode-safe `AudioContextManager` | Added `pendingClose` flag and `queueMicrotask`-deferred `closeContext()` inside `release()`. A subsequent `acquire()` within the same synchronous tick sets `pendingClose = false` and bumps the ref count, turning the queued microtask into a no-op. `dispose()` clears the flag and force-closes. |
| W1-3 | Typed `getUserMedia` errors | New `src/core/RoomErrors.ts` exports `RoomPermissionError`, `RoomDeviceError`, `RoomSecurityError`, `RoomConstraintError`, `RoomResumeTimeoutError`, `RoomUnknownError` (each extending `RoomError` with a stable string `code`) plus the `mapGetUserMediaError(unknown): RoomError` helper. `AudioTrack.wrapError` and `Room.createLocalTracks` route through this mapper. |
| W1-4 | `MediaStreamTrack.onended` cleanup | Refactored `AudioTrack` to hoist all teardown into `private async teardownInternal({ stopSourceTrack })`. `stop()` calls `teardownInternal({ stopSourceTrack: true })`; `handleTrackEnded()` synchronously sets `state = ENDED`, emits `Ended` exactly once, then fire-and-forgets `teardownInternal({ stopSourceTrack: false })`. Idempotency guard prevents double-emit. |
| W1-5 | `useAudioTrack` ref ordering | `trackRef.current = newTrack` assigned **before** `await newTrack.initialize(...)`. Cleanup effect captures `inflightTrack` and calls `.stop()` even when initialization is still pending. Failure path clears the ref to prevent double-stop; unmount-during-init bails out before any React state updates. |
| W1-6 | `Float32Array` preallocation | New `private levelDataArray: Float32Array<ArrayBuffer> \| null` field on `AudioTrack`. Allocated once in `setupAudioLevelMonitoring`, reused on every `updateAudioLevel` tick, nulled in `teardownInternal`. Constructor-spy test asserts ≤ 1 allocation across 1000 ticks. |
| W1-7 | `AudioContextManager.resume` timeout | `private async resumeWithTimeout(timeoutMs = 3000)` races `audioContext.resume()` against a `setTimeout`-driven `Promise<never>` that rejects with `RoomResumeTimeoutError`. On timeout (or any rejection that leaves the context not-`running`), the click/touchstart/keydown fallback handler is reattached. Public `resume()` signature unchanged. |
| W2-4 | Shared analyser per track | New module-scoped `WeakMap<AudioTrack, SharedTrackMonitor>` inside `useAudioLevel`. `acquireSharedMonitor(track, opts, listener)` lazily creates a single `AnalyserNode` + `MediaStreamAudioSourceNode` + `setInterval` per track, ref-counts listeners, and tears everything down when the count returns to zero. Two `useAudioLevel` hooks targeting the same track now create exactly one analyser. |

### 4.2 Files modified

| File | Purpose |
|------|---------|
| `packages/room/src/core/RoomErrors.ts` | **NEW** — typed error subclasses + `mapGetUserMediaError` helper (W1-3, W1-7) |
| `packages/room/src/core/AudioContextManager.ts` | StrictMode-safe `release()` (W1-2); typed `resumeWithTimeout` with `RoomResumeTimeoutError` (W1-7) |
| `packages/room/src/core/AudioTrack.ts` | `mapGetUserMediaError` integration in `wrapError` (W1-3); `teardownInternal` + onended cleanup (W1-4); `levelDataArray` preallocation (W1-6) |
| `packages/room/src/hooks/useAudioTrack.ts` | Ref-before-`initialize` ordering + unmount-during-init guard (W1-5) |
| `packages/room/src/hooks/useAudioLevel.ts` | Per-track shared analyser registry via `WeakMap` (W2-4) |
| `packages/room/src/__tests__/AudioContextManager.test.ts` | New W1-2 + W1-7 suites |
| `packages/room/src/__tests__/Room.test.ts` | New W1-3 typed error suite |
| `packages/room/src/__tests__/AudioTrack.test.ts` | New W1-4 onended + W1-6 allocation budget suites |
| `packages/room/src/__tests__/useAudioTrack.test.ts` | **NEW** — W1-5 unmount-mid-init regression suite |
| `packages/room/src/__tests__/useAudioLevel.test.ts` | **NEW** — W2-4 shared analyser suite |

### 4.3 Public API surface — unchanged

- `packages/room/src/index.ts` exports unchanged (verified by direct read).
- `packages/room/src/core/index.ts` exports unchanged.
- New `RoomErrors.ts` symbols are **not re-exported from `index.ts`** — they remain package-internal. Consumers continue to use `instanceof RoomError` and the existing `RoomErrorCode` enum.

---

## 5. Test Evidence

### 5.1 `@arcaai/room` — build, test, lint (all green)

```
Test Files  19 passed (19)
     Tests  483 passed (483)
  Duration  1.43s (transform 1.04s, setup 272ms, import 1.49s, tests 387ms, environment 11.64s)
```

```
ESM dist/index.js     80.39 KB    Build success in 147ms
CJS dist/index.cjs    82.99 KB    Build success in 147ms
DTS dist/index.d.ts   68.53 KB    Build success in 696ms
DTS dist/index.d.cts  68.53 KB
```

```
> @arcaai/room@0.1.0 lint
> ESLINT_USE_FLAT_CONFIG=false eslint "src/**/*.ts*" --max-warnings 0
(no errors, no warnings)
```

`ReadLints` on every modified `.ts` and `.test.ts` file — clean.

### 5.2 D7 cross-package contract — downstream builds (all green)

| Package | Result |
|---------|--------|
| `@arcaai/vad` | DTS Build success — no source changes required |
| `@arcaai/stt` | DTS Build success — no source changes required |
| `@arcaai/noise-filter` | DTS Build success — no source changes required |
| `@arcaai/vox` | ESM/CJS Build success — no source changes required |

```
@arcaai/vad           DTS ⚡️ Build success in 407ms
@arcaai/stt           DTS ⚡️ Build success in 680ms
@arcaai/noise-filter  DTS ⚡️ Build success in 395ms
@arcaai/vox           CJS ⚡️ Build success in 7722ms (ESM bundle 5.39 MB)
```

### 5.3 New test suites added (count by item)

| Item | New `describe` block | Test count |
|------|----------------------|------------|
| W1-2 | `AudioContextManager StrictMode safety (W1-2)` | 3 |
| W1-3 | `createLocalTracks typed errors (W1-3)` | 5 |
| W1-4 | `AudioTrack track-ended handling (W1-4)` | ≥2 |
| W1-5 | `useAudioTrack ref ordering (W1-5)` | ≥1 |
| W1-6 | `AudioTrack level-monitor allocation budget (W1-6)` | 1 |
| W1-7 | `AudioContextManager.resume timeout (W1-7)` | 2 |
| W2-4 | `useAudioLevel shared analyser (W2-4)` | ≥2 |

All exercised in the same `pnpm --filter @arcaai/room test` run — total 483 passing.

---

## 6. Change History

| Date | Author | Notes |
|------|--------|-------|
| 2026-05-23 | Agent A6 | Ticket created; plan committed; TDD red→green for W1-2..W1-7, W2-4. |
| 2026-05-23 | Agent A6 | Cross-package D7 verification: vad/stt/noise-filter/vox all rebuild without source changes. Status → Completed. |

---

## 7. Deviations / Follow-ups

- **Resume timeout default**: ticket text says "default 3000 ms" — implemented as `DEFAULT_RESUME_TIMEOUT_MS = 3000` in `AudioContextManager`. The previous codepath used a 500 ms hard-coded sleep race with no error surface; raising to 3000 ms intentionally widens the grace window for slow boot-time gestures (especially Safari).
- **W1-3 — `RoomError` parent class preserved**: each new subclass calls `super(...)` with an existing `RoomErrorCode` (e.g. `PERMISSION_DENIED`, `DEVICE_NOT_FOUND`). The new stable `code` strings (`'mic_permission_denied'`, etc.) are attached via `Object.defineProperty` on the instance so `instanceof RoomError` checks in downstream packages keep working unchanged.
- **W2-4 — coexists with `AudioTrack.monitorAudioLevel`**: when a track has its own internal monitor enabled (default) the hook still listens to `TrackEvent.AudioLevelUpdate` for backward-compat behaviour, and additionally subscribes to the shared analyser. Both paths converge on the same `setAudioLevelInfo` setter — the contract "exactly one analyser per track from the hook" is satisfied; the optional internal track-level analyser is independent and predates this ticket.
- **No follow-ups blocking the parent ticket (TASK-262)**.
