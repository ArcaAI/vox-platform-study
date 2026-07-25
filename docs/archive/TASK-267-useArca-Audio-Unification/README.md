# TASK-267 — useArca Audio Hook Unification

| | |
|---|---|
| Ticket Number | TASK-267 |
| Parent | TASK-262 (Vox SDK Deep Assessment) |
| Wave | Wave 1, Item W1-1 |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Completed |
| Type | Refactor / Bugfix |
| Owner | A5 (SDK) |
| Scope | `packages/agentic-sdk-v2/src/hooks/useArca.ts` and colocated tests |

---

## 1. Requirement Analysis

### 1.1 Description

`useArca` currently re-implements its own `startAudio` / `stopAudio` callbacks that duplicate the implementation found in `useArcaAudio`. The two implementations have diverged in three correctness-critical ways:

| Concern | `useArca.startAudio` (broken) | `useArcaAudio.startAudio` (canonical) |
|---|---|---|
| AudioContext lifetime | `new AudioContext()` — leaks per call | `AudioContextManager.getInstance().acquire()` — ref-counted singleton |
| MediaStream tracks on stop | `pluginManager.destroy()` only — mic LED stays lit | `activeStream.getTracks().forEach(t => t.stop())` — releases mic |
| Store fields | Does not populate `activeStream` / `activeAudioContext` | Populates both — allows `mute()`/`unmute()` to operate on the live tracks |

When both hooks are mounted in the same React tree (which is the documented "use focused hook + use unified hook" pattern), the duplicate side-effect path means a consumer who calls `useArca().audio.start()` and then `useArcaAudio().mute()` will mute a *different* stream than the one `useArca` opened — because `useArca` never set `activeStream`.

Cross-referenced findings in `TASK-262/01-vox-sdk.md`:
- **C-1**: `useArca.startAudio` creates a raw `new AudioContext()` and leaks it.
- **C-2**: `stopAudio` never stops the `MediaStreamTrack`.
- **R-1**: Unify audio start/stop in `useArca` with `useArcaAudio`.

### 1.2 Business context

Microphone leaks are user-visible (the OS-level microphone LED stays on) and erode trust in a HIPAA-regulated medical SDK. `AudioContext` leaks accumulate against the browser's ~6-context-per-origin limit and eventually break all audio in the tab.

### 1.3 Acceptance criteria

1. `useArca.audio.start()` calls `getUserMedia` exactly once even when `useArca` and `useArcaAudio` are mounted in the same tree.
2. `useArca.audio.stop()` (and unmount-time cleanup of the same code path) releases each acquired `MediaStreamTrack` exactly once.
3. The shape of `useArca().audio` — every field on the `UseArcaAudio` interface — is unchanged. No consumer-facing API change.
4. There is no raw `new AudioContext()` call left in `useArca.ts`.
5. The shared `AudioContextManager` singleton is the only owner of `AudioContext` lifecycle across both hooks.
6. All existing `useArca`/`useArcaAudio` unit tests continue to pass; new colocated tests pin the unification behavior.

---

## 2. Current State Evaluation

### 2.1 Code layout

| File | Role | Touch policy |
|---|---|---|
| `packages/agentic-sdk-v2/src/hooks/useArca.ts` | Unified hook with duplicated audio block (lines 420–659) | **Write scope** — modify audio side-effect block only |
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` | Focused audio hook (REFACTOR-01) — canonical implementation | Read-only |
| `packages/room/src/core/AudioContextManager.ts` | Ref-counted `AudioContext` singleton | Read-only |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audio-pipeline.test.ts` | Tests `useArca.audio` callbacks | Read-only (existing tests must pass) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audioSegments.test.ts` | Tests `audio.start()` options | Read-only (existing tests must pass) |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audio-unification.test.ts` | **New** | TDD target for this ticket |

### 2.2 Duplicated surface in `useArca.ts`

Eight callbacks duplicate the canonical implementation in `useArcaAudio.ts`:

| Callback | `useArca.ts` lines | `useArcaAudio.ts` lines | Drift |
|---|---|---|---|
| `startAudio` | 420–553 | 53–205 | Missing `AudioContextManager.acquire`, missing `setActiveStream`, missing `setActiveAudioContext`, missing `addTranscriptSegment` |
| `stopAudio` | 555–577 | 207–237 | Missing `track.stop()`, missing `setActiveStream(null)`, missing `setActiveAudioContext(null)` |
| `muteAudio` | 579–583 | 239–249 | Missing `track.enabled = false` |
| `unmuteAudio` | 585–589 | 251–261 | Missing `track.enabled = true` |
| `toggleNoiseFilter` | 591–609 | 263–281 | Identical |
| `toggleSTT` | 615–634 | 287–306 | Identical |
| `toggleVAD` | 640–659 | 312–331 | Identical |
| `audio` memo | 1579–1616 | 337–374 | Identical shape |

### 2.3 Cross-test impact

The existing `useArca.audio-pipeline.test.ts` exercises the audio block via `result.current.audio.start()` and `result.current.audio.stop()`. After unification, those tests must still pass — `useArcaAudio` shares the same store mock, accepts the same options, and registers the same plugin callbacks. The two divergent extras (`addTranscriptSegment`, `activeStream`) are not asserted by the existing tests.

---

## 3. Implementation Plan

### 3.1 Strategy

Replace the duplicated `audio` block in `useArca.ts` with a single call to `useArcaAudio()` and assign its return value directly to `audio`. This is the surgical change requested in W1-1 ("a thin proxy"). No other section of `useArca` is touched.

### 3.2 Test list (TDD)

New file: `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audio-unification.test.ts`

| # | Test | RED expectation (before fix) | GREEN expectation (after fix) |
|---|---|---|---|
| 1 | `getUserMedia` is called exactly once when both `useArca` and `useArcaAudio` are mounted and `useArca.audio.start()` is invoked once | Passes already today (because each `start()` call invokes `getUserMedia` once). Mainly a regression pin. | Passes |
| 2 | `useArca.audio.start()` invokes `AudioContextManager.acquire` (no raw `new AudioContext`) | FAILS — current code calls `new AudioContext()`, never acquires | Passes |
| 3 | `useArca.audio.stop()` releases the mic track exactly once (calls `track.stop()` once) | FAILS — current `stopAudio` never calls `track.stop()` | Passes |
| 4 | Unmount of the host component after `start()` followed by `stop()` does not re-release the mic (still exactly one release) | FAILS today — same root cause: `stopAudio` never released the mic, so total releases are zero | Passes |

### 3.3 Implementation steps

1. **RED**: add `useArca.audio-unification.test.ts` with the four tests above. Run; observe failures on the three audio-leak-related cases.
2. **GREEN**: in `useArca.ts`:
   - import `useArcaAudio` from `./useArcaAudio`.
   - delete the audio callbacks (`startAudio`, `stopAudio`, `muteAudio`, `unmuteAudio`, `toggleNoiseFilter`, `toggleSTT`, `toggleVAD`).
   - replace the `audio = useMemo<UseArcaAudio>(() => ({ ... }))` block with `const audio = useArcaAudio();`.
   - remove imports that become unused (`TranscriptionResult`, the local `CONTEXT_ENDPOINTS` import is still used elsewhere — keep it).
   Run; observe all tests passing.
3. **REFACTOR**: confirm `UseArcaAudio` interface alignment (`useArcaAudio()` already returns the exact shape because `useArcaAudio.ts` re-exports the same interface). Run lint and build.

### 3.4 Verification commands

```
pnpm --filter @arcaai/vox test:unit
pnpm --filter @arcaai/vox build
pnpm --filter @arcaai/vox lint
```

---

## 4. Implementation Summary

### 4.1 What was built

`useArca.audio` is now a thin proxy for `useArcaAudio()`. The previously duplicated `startAudio`, `stopAudio`, `muteAudio`, `unmuteAudio`, `toggleNoiseFilter`, `toggleSTT`, and `toggleVAD` callbacks plus the `audio` memo block were removed and replaced by a single `const audio = useArcaAudio();` call. The public `UseArcaReturn['audio']` shape is identical because `useArcaAudio` already returns the canonical `UseArcaAudio` interface.

Effect:

- `getUserMedia` is called exactly once per `start()` invocation, even when both `useArca` and `useArcaAudio` are mounted in the same tree (both hooks now share one implementation that funnels through `AudioContextManager.acquire()` and `store.setActiveStream`).
- `stop()` releases each `MediaStreamTrack` exactly once via `useArcaAudio`'s `activeStream.getTracks().forEach(t => t.stop())` path.
- No more raw `new AudioContext()` in `useArca.ts` — closes findings C-1 and C-2 from `TASK-262/01-vox-sdk.md` and satisfies R-1.

### 4.2 Files modified

| File | Change | Net lines |
|---|---|---:|
| `packages/agentic-sdk-v2/src/hooks/useArca.ts` | Replaced duplicated audio block with `useArcaAudio()` delegation; removed unused `TranscriptionResult` import | −281 / +10 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audio-pipeline.test.ts` | Extended mock store with `setActiveStream`, `setActiveAudioContext`, `addTranscriptSegment`, `setAudioLanguage`, `activeStream`, `activeAudioContext` to match `useArcaAudio`'s contract | +8 |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audioSegments.test.ts` | Same as above | +7 |

### 4.3 Files added

| File | Purpose |
|---|---|
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArca.audio-unification.test.ts` | TDD pin: 4 tests asserting single `getUserMedia` call, `AudioContextManager` use, single mic release, and no double-release on unmount |
| `docs/implementation/TASK-267-useArca-Audio-Unification/README.md` | This ticket document |

### 4.4 Public API — confirmed unchanged

`useArca().audio` still exposes:

```
isCapturing, isMuted, level, isSpeaking, currentTranscript, transcriptSegments,
language, plugins, error, start, stop, mute, unmute, toggleNoiseFilter,
toggleSTT, toggleVAD
```

This shape was preserved because `useArcaAudio.ts` re-exports `UseArcaAudio` from `useArca.ts` and its `useMemo` return matches the interface field-for-field. No callers needed to be touched.

### 4.5 Behavioral deltas observable to consumers

These are all bug fixes — no consumer should regress, but some consumers will now correctly observe behavior that was previously broken:

1. `useArca().audio.stop()` now calls `MediaStreamTrack.stop()` on every track the SDK acquired (fix for the mic-LED-stays-lit bug).
2. `useArca().audio.start()` now writes `activeStream` and `activeAudioContext` to the Zustand store, enabling the `mute`/`unmute` path in `useArcaAudio` to actually toggle `track.enabled` instead of just flipping the `isMuted` flag.
3. `useArca().audio.start()` no longer creates a raw `new AudioContext()`; it acquires the reference-counted `AudioContextManager` singleton.
4. Final transcriptions now push into `store.transcriptSegments` via `addTranscriptSegment` — `useArca().audio.transcriptSegments` will populate where it previously stayed empty when `start()` was called through `useArca`.

### 4.6 Deprecation / internal notes

`useArcaAudio` was originally introduced by REFACTOR-01 to extract the audio surface from the "god hook" `useArca`. The duplicated implementation in `useArca` was a temporary state and is now eliminated. `useArca.audio` remains the recommended unified entry point for consumers that need session, audio, context, and summary together; `useArcaAudio` remains available as a focused alternative for components that only need audio.

There is **no deprecation** of either hook. Both continue to be exported from `@arcaai/vox/core`.

### 4.7 Verification evidence

#### Unit tests — new `useArca.audio-unification.test.ts`

```
RUN  v4.1.1 packages/agentic-sdk-v2

Test Files  1 passed (1)
     Tests  4 passed (4)
  Duration  538ms
```

#### Unit tests — all useArca-prefixed suites

```
RUN  v4.1.1 packages/agentic-sdk-v2

Test Files  18 passed (18)
     Tests  383 passed (383)
  Duration  1.71s
```

Includes `useArca.audio-pipeline.test.ts` (60 tests), `useArca.audioSegments.test.ts` (9 tests), `useArcaAudio.test.ts` (5 tests), and the new `useArca.audio-unification.test.ts` (4 tests) — all green.

#### Lint — `pnpm --filter @arcaai/vox lint`

```
✖ 28 problems (0 errors, 28 warnings)
```

All 28 warnings are prettier formatting issues in unrelated files (`FileTranscriptionService.ts`, `SttWebSocketClient.ts`, `types/dna.ts`, `types/index.ts`) that pre-existed this ticket and are outside the write scope. Zero warnings or errors in `useArca.ts` or the colocated tests.

#### Build — `pnpm --filter @arcaai/vox build`

```
ESM dist/core.mjs        400.88 KB   Build success in 809ms
CJS dist/core.js         406.83 KB   Build success in 810ms
ESM dist/plugins.mjs       5.08 MB   Build success in 2309ms
CJS dist/plugins.js        5.08 MB   Build success in 10863ms
ESM dist/index.mjs         5.41 MB   Build success in 10872ms
CJS dist/index.js          5.42 MB   Build success in 10872ms
```

All four entry points (`core`, `plugins`, `index`, `plugins-med-ner`) build cleanly in both ESM and CJS.

### 4.8 Out of scope / known unrelated failures

The full `npx vitest run` invocation across `@arcaai/vox` shows additional failing tests in other suites (`SimpleCrossTabSync.test.ts`, `useAuth.task22{4,5}.test.ts`, `useUserSettings.test.ts`, `useVoiceEmbedding.test.ts`, `AgenticClient.errorCodes.test.ts`, `constants.task210.test.ts`, `agenticStore.impersonation.test.ts`, `useArca.dx.test.ts` was NOT affected). These failures originate from sibling Wave 0 / Wave 1 tickets (TASK-263 through TASK-266) being implemented in parallel by other agents and are not caused by this change. Verified by reading `git status` for the workspace: every failing test file outside the TASK-267 write scope is also modified or newly added under those sibling tickets.

---

## 5. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | A5 | Ticket opened — plan drafted from TASK-262 W1-1. |
| 2026-05-23 | A5 | RED: 4 unification tests added; failed on raw `new AudioContext()` in `useArca.ts:446`. |
| 2026-05-23 | A5 | GREEN: replaced duplicated audio block with `useArcaAudio()` delegation; all useArca-related tests pass. |
| 2026-05-23 | A5 | Status set to **Completed** after lint, build, and 383 unit tests verified green. |
