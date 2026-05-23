# TASK-276 — `useSTT` Realignment to Post-A8 `STTProcessor` API

**Ticket:** TASK-276 (Wave-1A · B3)
**Parent / Predecessor:** TASK-270 (A8 — `@arcaai/stt` critical fixes)
**Created:** 2026-05-23
**Updated:** 2026-05-23
**Status:** Completed
**Owner:** Agent B3

---

## 1. Requirement Analysis

### Description

After TASK-270 reshaped `@arcaai/stt`'s `STTProcessor`, the React hook
`packages/stt/src/hooks/useSTT.ts` was flagged in TASK-270 §Deviations as having
"pre-existing TypeScript errors" against the new processor surface (specifically
the `destroy()` / `on()` / `off()` calls and missing `@arcaai/room`
declarations). The Wave-1A brief assigned B3 to realign that hook so:

- `pnpm --filter @arcaai/stt typecheck` exits cleanly.
- The hook compiles against the current `STTProcessor` API
  (`destroy`, `on`/`off` via `TypedEventEmitter`, `releaseWarmResources`,
  `transcribeSegment`, `setLanguage`, `getProviderType`).
- The hook's public return surface (`UseSTTOptions` / `UseSTTReturn`) is kept
  stable for downstream consumers (`@arcaai/vox`) unless the new processor API
  forces a breaking signature, in which case the deviation must be documented.

### Business Context

`useSTT` is the React entry-point that `@arcaai/vox`'s `useArca` composes into
its consultation audio pipeline. A broken hook would cascade into
`@arcaai/vox` builds, the UI playground, and the admin app's recording flow.

### Acceptance Criteria

1. `pnpm --filter @arcaai/stt typecheck` exits with 0 — no pre-existing or
   newly-introduced TS errors in `useSTT.ts`.
2. `pnpm --filter @arcaai/stt test`, `pnpm --filter @arcaai/stt build`, and
   `pnpm --filter @arcaai/stt lint` all stay green.
3. `pnpm --filter @arcaai/vox build` (downstream smoke) stays green.
4. New / updated tests assert the post-A8 method surface on `STTProcessor`
   that `useSTT` depends on:
   `destroy`, `on(ProcessorEvent.Data|Error, …)`, `off(...)`,
   `releaseWarmResources`, `transcribeSegment`, `setLanguage`,
   `getProviderType`.

### Out of Scope

- Any change to `STTProcessor.ts`, engines, providers, websocket client,
  workers, worklets, or the rest of `@arcaai/stt`. Those remain frozen for
  this ticket per the Wave-1A B3 write-scope.
- Other hooks (`useArca*`, `useVAD`, `useNoiseFilter`, etc.).
- The duplicate `packages/stt/src/__tests__/useSTT.test.ts` shape-only test
  file. It lives outside this ticket's write scope and is left untouched.

---

## 2. Current State Evaluation

### Investigation snapshot at start of ticket

Before writing any new code, I ran every verification gate against HEAD +
staged Wave-0 (TASK-263 … TASK-273) state to establish a baseline. Result:
everything was already green. The pre-existing TS errors that TASK-270's
README §Deviations called out were no longer present.

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm --filter @arcaai/stt typecheck` | exit 0, no errors |
| Build | `pnpm --filter @arcaai/stt build` | clean ESM + CJS + worker + DTS |
| Tests | `pnpm --filter @arcaai/stt test` | 17 files / 306 tests passing |
| Lint | `pnpm --filter @arcaai/stt lint` | exit 0 (only the eslintrc shim deprecation noise) |
| Downstream | `pnpm --filter @arcaai/vox build` | clean |

`tsc --noEmit --listFiles` confirms `src/hooks/useSTT.ts` is included in the
typecheck (it is — `include: ["src/**/*"]` and not in the `exclude` list, since
`exclude` only filters `*.test.ts` / `*.spec.ts`).

### What `useSTT.ts` already does that aligns with post-A8 `STTProcessor`

| Call site in `useSTT.ts` | Backing API on current `STTProcessor` |
|---|---|
| `new STTProcessor({ …, onModelProgress })` | `STTProcessor` constructor accepts `STTOptions` (now includes `prompt` and `onModelProgress`) |
| `processor.destroy()` | Inherited from `BaseProcessor.destroy()` (idempotent) |
| `processor.releaseWarmResources()` | Public method on `STTProcessor` (warm-pool release, post-TASK-244) |
| `processor.on(ProcessorEvent.Data, …)` / `.on(ProcessorEvent.Error, …)` | Inherited from `TypedEventEmitter<ProcessorEventMap>` |
| `processor.off(ProcessorEvent.Data, …)` / `.off(ProcessorEvent.Error, …)` | Same, removes the matching handler |
| `processor.getProviderType()` | Public method on `STTProcessor` |
| `processor.transcribeSegment(audio)` | Public method on `STTProcessor` |
| `processor.setLanguage(language)` | Public method on `STTProcessor` |

### Why TASK-270 saw errors but Wave-0 doesn't

`useSTT.ts` was last modified in commit `c81c1f0` ("refactor(stt): streamline
imports and improve code formatting"), which already shaped it to the post-A8
API. TASK-270's §Deviations note appears to have described a transient state
during A8's own work; by the time Wave-0 was sealed (HEAD + staged
TASK-263 … TASK-273), the hook was already in alignment.

### Files affected by this ticket

| File | Action | Why |
|---|---|---|
| `packages/stt/src/hooks/useSTT.ts` | **No change** | Already aligned with the current `STTProcessor` API |
| `packages/stt/src/hooks/index.ts` | **No change** | Barrel already re-exports `useSTT` |
| `packages/stt/src/hooks/__tests__/useSTT.test.ts` | **Extended** | Added a "Post-A8 STTProcessor API alignment (TASK-276)" describe block that locks in the contract |
| `docs/implementation/TASK-276-useSTT-Realignment/README.md` | **New** | This document |

---

## 3. Implementation Plan

### TDD outline

Standard RED → GREEN → REFACTOR cannot literally apply here because the
hook already compiled and the existing tests passed before the ticket began.
The honest TDD adaptation:

1. **Audit** — confirm typecheck/build/test/lint baseline is green and
   inspect every call site in `useSTT.ts` against the current `STTProcessor`
   surface (§2 above).
2. **Lock-in tests** — add focused tests that pin the post-A8 API surface
   the hook depends on. Each test would have been RED if `useSTT.ts` were
   still in pre-A8 shape (e.g. calling a removed method, missing the warm-
   resource release, mis-typed event payloads).
3. **Verify** — re-run every gate plus the downstream `@arcaai/vox` build
   smoke.

### New tests (all colocated in `packages/stt/src/hooks/__tests__/useSTT.test.ts`)

| Test | Locks in |
|---|---|
| subscribes to `ProcessorEvent.Data` and `ProcessorEvent.Error` on the processor | `processor.on(ProcessorEvent.{Data,Error}, …)` wiring |
| unsubscribes from data + error events when the processor is recreated | `processor.off(ProcessorEvent.{Data,Error}, …)` cleanup on config-fingerprint change |
| calls `releaseWarmResources` after `destroy` on unmount | The new warm-pool release contract on unmount |
| `transcribeSegment` proxies to `processor.transcribeSegment` | Direct passthrough including state side-effects |
| forwards `setLanguage` to the underlying processor | `processor.setLanguage(locale)` is called and `language` state mirrors it |
| updates `finalTranscripts` when processor emits `stt-transcription` | `BaseProcessor.emitData('stt-transcription', result)` reducer path |
| updates `currentTranscript` when processor emits `stt-partial` | `stt-partial` reducer path + `isProcessing` flag |
| updates `stats` when processor emits `stt-stats` | `stt-stats` reducer path |
| propagates `ProcessorEvent.Error` to the error state and `onError` callback | Error handler wiring + callback ref pass-through |
| `clear()` resets transcripts, current text, and error state | Public `clear()` semantics |

These tests use a refined mock of `STTProcessor` that records `on(event, …)`
handlers in a `Map` so a test can synthesise a data/error event back into the
hook (the previous mock kept `on`/`off` as bare `vi.fn()` stubs).

---

## 4. Implementation Summary

### What changed

- **`packages/stt/src/hooks/useSTT.ts`** — no edits. The hook was already in
  alignment with the post-A8 `STTProcessor` surface.
- **`packages/stt/src/hooks/index.ts`** — no edits. The `useSTT` barrel
  export already matches the current public types.
- **`packages/stt/src/hooks/__tests__/useSTT.test.ts`** — added a new
  `Post-A8 STTProcessor API alignment (TASK-276)` describe block with 10
  tests (see §3 table). The previous mock for `STTProcessor` was extended
  from bare `vi.fn()` stubs into a recording emitter so the event-reducer
  paths in the hook can be exercised. The four existing "D2 regression"
  describe blocks were left untouched.
- **`docs/implementation/TASK-276-useSTT-Realignment/README.md`** — new
  ticket document (this file).

### Hook surface, kept stable

`UseSTTOptions` and `UseSTTReturn` are unchanged. Downstream `@arcaai/vox`
consumers see the same options object and return shape as before.

---

## 5. Verification

### Gate evidence (all run from repo root, zsh)

`pnpm --filter @arcaai/stt typecheck` — **exit 0**

```
> @arcaai/stt@0.1.0 typecheck /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/stt
> tsc --noEmit
```

`pnpm --filter @arcaai/stt test` — **316 tests passing across 17 files**
(was 306 before this ticket; the +10 are the new TASK-276 lock-in tests):

```
 Test Files  17 passed (17)
      Tests  316 passed (316)
   Start at  23:44:01
   Duration  1.49s
```

`pnpm --filter @arcaai/stt build` — **exit 0**, clean ESM + CJS + DTS +
worker:

```
ESM dist/index.mjs     100.17 KB
CJS dist/index.js     102.80 KB
ESM dist/workers/whisper.worker.mjs     1.69 MB
DTS dist/index.d.ts  56.98 KB
DTS dist/index.d.mts 56.98 KB
```

`pnpm --filter @arcaai/stt lint` — **exit 0** (the only output is the
eslintrc-shim deprecation warning, not a rule violation — pre-existing
tooling noise inherited from TASK-270).

`ReadLints` on `packages/stt/src/hooks/useSTT.ts`,
`packages/stt/src/hooks/__tests__/useSTT.test.ts`, and
`packages/stt/src/hooks/index.ts` — **No linter errors found.**

`pnpm --filter @arcaai/vox build` (downstream smoke) — **exit 0**:

```
ESM dist/index.mjs     5.42 MB
CJS dist/index.js     5.43 MB
ESM dist/plugins.mjs   5.09 MB
CJS dist/plugins.js   5.09 MB
ESM dist/core.mjs    404.13 KB
CJS dist/core.js     410.08 KB
```

The `"use client"` directive + unused-React-import warnings emitted by the
`@arcaai/vox` bundler are pre-existing and unrelated to this ticket; they
also appeared before any TASK-276 change.

---

## 6. Deviations

1. **No code change to `useSTT.ts`.** The Wave-1A brief assumed pre-existing
   typecheck errors (per TASK-270's §Deviations note). At the start of this
   ticket, against HEAD + staged Wave-0 state, `pnpm --filter @arcaai/stt
   typecheck` already exited 0 and the hook already used the post-A8
   `STTProcessor` surface. The honest finding is that the realignment was
   already in place — likely landed by an interim commit before Wave-0 was
   sealed. Rather than refactor speculatively, this ticket:
   - documents the no-op outcome explicitly,
   - adds lock-in tests so the contract cannot drift back, and
   - keeps every other write-scope file unchanged.
2. **Public hook return shape unchanged.** `UseSTTOptions` and `UseSTTReturn`
   are identical to the pre-ticket state; downstream `@arcaai/vox` requires
   no migration.
3. **TDD "RED" phase is implicit, not literal.** Because `useSTT.ts` was
   already in alignment, the new tests pass on first run. They would have
   been red against the hypothetical pre-A8 hook shape that TASK-270's note
   described, which is the contract they pin.

---

## 7. Discovered-But-Not-Fixed Issues

These are outside this ticket's write scope (per Wave-1A B3) and are logged
here so the next ticket can pick them up:

| # | Location | Observation | Suggested follow-up |
|---|---|---|---|
| 1 | `packages/stt/src/hooks/useSTT.ts` lines 217-220 (`wasAttached = !!trackRef.current; previousTrack = trackRef.current; … if (wasAttached && previousTrack)`) | `wasAttached && previousTrack` is structurally redundant — both terms are derived from the same `trackRef.current` snapshot, so the second is always true when the first is. Cosmetic, not a bug. | Simplify in a future hook-cleanup ticket; out of scope here. |
| 2 | `packages/stt/src/hooks/useSTT.ts` line 159 (`useState<LanguageLocale>(sttOptions.audio?.language ?? 'en-US')`) | Local `language` state is initialised once and only updated by `setLanguage()` — if the caller changes `sttOptions.audio.language` between renders without calling `setLanguage`, the hook's reported `language` will be stale. Pre-existing behavior. | Either drive `language` from the processor (`processor.getLanguage()`) or sync on `configFingerprint` change in a future ticket; touching it now would expand the diff beyond the Wave-1A B3 scope. |
| 3 | `packages/stt/src/__tests__/useSTT.test.ts` | Shape-only sibling test file exists alongside `packages/stt/src/hooks/__tests__/useSTT.test.ts`. It is purely structural (asserts mock object types) and may be redundant given the hook-located integration tests. Outside this ticket's write scope. | Consider consolidating in a future test-cleanup ticket. |
| 4 | `packages/stt` lint script | `ESLINT_USE_FLAT_CONFIG=false` emits a `ESLintRCWarning` deprecation banner on every run. Pre-existing tooling debt inherited from TASK-270. | Migrate to flat config in a tooling ticket. |

None of these are blockers; all are recorded for traceability.

---

## 8. Files Modified (final list, uncommitted)

| Path | Status |
|---|---|
| `packages/stt/src/hooks/useSTT.ts` | unchanged (verified in alignment) |
| `packages/stt/src/hooks/index.ts` | unchanged |
| `packages/stt/src/hooks/__tests__/useSTT.test.ts` | extended — `Post-A8 STTProcessor API alignment (TASK-276)` describe block added; mock recording shim added |
| `docs/implementation/TASK-276-useSTT-Realignment/README.md` | new (this file) |

---

## 9. Change History

### 2026-05-23 — TASK-276 initial pass (B3 / Wave-1A)

- Audited `useSTT.ts` against post-A8 `STTProcessor`; confirmed full
  alignment and that all verification gates were already green at baseline.
- Added 10 lock-in tests in `packages/stt/src/hooks/__tests__/useSTT.test.ts`
  covering `on`/`off`/`destroy`/`releaseWarmResources`/`transcribeSegment`/
  `setLanguage`/`getProviderType` and the four data-event reducers.
- All 6 verification gates green (typecheck, build, test, lint, ReadLints,
  `@arcaai/vox` downstream build).
- No code changes outside the test file and this README; write-scope honored.
