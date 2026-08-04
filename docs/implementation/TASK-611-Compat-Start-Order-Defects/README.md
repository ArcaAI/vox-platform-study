# TASK-611 — Compat start-order defects

| Field | Value |
|---|---|
| Status | Review |
| Type | bugfix (SDK + reference app) |
| Branch | `dev-2.1` |
| Packages | `@arcaai/vox` (`packages/agentic-sdk-v2`), `apps/quick-compat-app` |
| Related | TASK-609 (runtime sources), TASK-608 (raw capture), TASK-564/565 (delivered-metadata timeline), TASK-597 (source selection) |

## Requirement Analysis

The compat layer drives ONE audio graph through TWO hooks —
`useArcaSpeechToText` and `useAudioCapture` — both of which call
`useArcaAudio().start()` on the same underlying session, guarded by
`isCapturing`; whichever fires first wins the race and the other's options are
dropped. Only `useAudioCapture` carries device/source options (`deviceId`,
`additionalDeviceIds`, `dynamicSources`, ...), so **capture-first is the
correct start order for any app with a device picker** — this was established
as fact in TASK-609's Current State Evaluation.

TASK-609 flagged, but explicitly left out of scope, that the reference app
(`apps/quick-compat-app`) still starts STT-first behind a comment claiming
`useAudioCapture` carries no pipeline id and is therefore safe to start second
— a claim TASK-609 confirmed was already false (`useAudioCapture` does carry
`options.sttPipelineId`). Flipping that app's start order to capture-first is
the natural close-out of that gap.

Doing the flip surfaced a second, previously latent defect: the compat
metadata-timeline anchor (`captureStartMsRef`, used to attribute delivered
finals to the caller metadata bag active at capture time) was only ever
written from inside `startTranscription`, i.e. only on the STT-first path. On
a capture-first start, `startTranscription`'s own `isCapturing` guard fires
before the anchor line runs, so the anchor is silently never set. This had to
be fixed in the SDK before the reference app could safely change order.

A third, adjacent defect was found while working the source-management code
path this ticket touches: `useArcaAudio.removeSource(id)` deleted the id from
`sourceIdsRef` but left the corresponding `MediaStream` in
`sourceStreamsRef`, so a removed source kept receiving `mute()`/`unmute()`
writes (`applyEnabledToAllSources`, added in TASK-609) indefinitely.

Three items, one ticket:
1. Timeline-anchor fix in `useArcaSpeechToText` (SDK).
2. `removeSource` stream-registry cleanup in `useArcaAudio` (SDK).
3. Reference app: stale comment + STT-first → capture-first start order.

## Current State Evaluation

| Fact | Evidence |
|---|---|
| Both compat hooks call `audio.start()` guarded by the same `isCapturing` flag on one `useArcaAudio()` instance; whichever fires first wins | `useArcaSpeechToText.ts` / `useAudioCapture.ts` (both files, `isCapturing` guard at the top of their start functions) |
| `useAudioCapture` carries device/source options; `useArcaSpeechToText` does not | established in TASK-609, re-confirmed here |
| `startTranscription`'s pre-anchor (`if (captureStartMsRef.current === undefined) captureStartMsRef.current = Date.now()`) sits AFTER its own `isCapturing` early return, so it never runs when capture already won the race | `useArcaSpeechToText.ts`, RED run below |
| An unset `captureStartMsRef` makes every `sendAudioData` entry stamp `atMs = 0`, and `pickMetadataForFinal` degrades to "attribute to the most recent metadata bag" instead of window-correct attribution | `speechToTextMetadata.ts:114`; empirically confirmed by the RED run (a final at `startTime=1s` was attributed to the last-set bag instead of the bag whose window contained it) |
| `removeSource(id)` filtered `sourceIdsRef` but not `sourceStreamsRef`, so a removed stream kept receiving `track.enabled` writes from `applyEnabledToAllSources` | RED run below (`micB._track._writes` non-empty after removal) |
| The reference app's comment at `LiveTranscription.tsx:53-68` claimed only `useArcaSpeechToText` carries `pipelineId`, used to justify STT-first start | file read, pre-edit |

## Implementation Summary

### 1. Timeline-anchor fix (`src/compat/useArcaSpeechToText.ts`)

Added a `useEffect` keyed on `audio.isCapturing` that anchors
`captureStartMsRef.current` on the false→true transition (via a
`wasCapturingRef` latch), guarded by `captureStartMsRef.current === undefined`
so it never overwrites an anchor already set. The existing synchronous
pre-anchor inside `startTranscription` was kept, not replaced — deliberately:

- On the STT-first path, `startTranscription`'s own anchor is strictly
  earlier than anything the effect could set (the effect needs a store update
  and a React flush), so removing it would widen the window where
  `sendAudioData` calls made between `audio.start()` and the effect running
  would land un-anchored, i.e. reintroduce the same bug on a path that
  currently works.
- Effect-only would also have broken the existing guard suite
  (`useArcaSpeechToText.test.ts:345,377,529`), whose audio mock never flips
  `isCapturing` after `startTranscription` — those tests lock the STT-first
  anchor independent of any transition.

Net effect: whichever of the two hooks wins the start race, the anchor now
gets set exactly once, either synchronously (STT-first) or on the capture
transition (capture-first, or an app that only calls `useAudioCapture` and
never calls `startTranscription` at all). `stopTranscription` still clears
the ref and resets the latch, so a re-open re-anchors correctly.

New test file: `src/compat/__tests__/useArcaSpeechToText.timelineAnchor.task611.test.ts`
(6 cases — capture-first flip after mount; already-capturing at mount;
STT-first no-regression; no re-anchor when the flip arrives after an
STT-first start; re-open re-anchors; no drift across repeated renders while
capturing). The anchor is observed indirectly, through which caller-metadata
bag a delivered final is attributed to — the timeline ref itself is private
and was not exported to make the assertion more direct.

RED (pre-fix; 4 of 6 new cases failing, the 2 passing being the STT-first
cases that already worked):
```
AssertionError: expected 'patient' to be 'clinician' // Object.is equality   (capture-first, flip after mount)
AssertionError: expected 'patient' to be 'clinician' // Object.is equality   (already active at mount)
AssertionError: expected 'patient' to be 'clinician' // Object.is equality   (re-anchors after stopTranscription)
AssertionError: expected 'patient' to be 'clinician' // Object.is equality   (no drift across repeated renders)
```

GREEN (new test + both directly-adjacent guard suites):
```
$ npx vitest run \
    src/compat/__tests__/useArcaSpeechToText.timelineAnchor.task611.test.ts \
    src/compat/__tests__/useArcaSpeechToText.test.ts \
    src/compat/__tests__/metadata-passthrough.contract.test.ts
 Test Files  3 passed (3)
      Tests  67 passed (67)
```

Behavioral note for reviewers: existing STT-first consumers see no change —
their anchor is still the pre-`audio.start` timestamp and the effect cannot
overwrite it. The new write path only activates where the anchor was
previously left `undefined` (i.e. previously broken): an app that starts
capture first, or one that drives `useAudioCapture` without ever calling
`startTranscription`. Such apps move from a uniform `atMs 0` (sticky
most-recent-bag attribution) to real capture-relative offsets and
window-correct attribution.

### 2. `removeSource` stream-registry cleanup (`src/hooks/useArcaAudio.ts`)

Added `sourceIdToStreamRef = useRef<Map<string, MediaStream>>(new Map())`,
populated at both places a source id is minted (the initial mixer-build loop
in `startAudio`, and `addSource` on a successful `mixer.addSource`), and
reset in lockstep with `sourceIdsRef` at all three existing reset points
(session-start reset, failed-start `catch`, `stopAudio` teardown).

`removeSource(id)` now looks up and deletes the id's map entry, and filters
that exact stream out of `sourceStreamsRef.current` in addition to the
existing `mixer.removeSource(id)` call and `sourceIdsRef` filtering — so
`applyEnabledToAllSources` (the TASK-609 mute/unmute-every-source path) and
`stopAudio`'s teardown loop no longer see a removed source. Pre-existing
guards (unknown id throws; refusing to remove the last source) are
untouched.

New test file: `src/hooks/__tests__/useArcaAudio.removeSourceCleanup.task611.test.ts`.

RED (pre-fix):
```
AssertionError: expected [ false ] to deeply equal []
- Expected: []
+ Received: [false]
 ❯ useArcaAudio.removeSourceCleanup.task611.test.ts:199:33
    expect(micB._track._writes).toEqual([]);
```

GREEN (new test + the five most directly related existing suites):
```
 Test Files  6 passed (6)
      Tests  39 passed (39)
```
(`useArcaAudio.removeSourceCleanup.task611.test.ts`,
`useArcaAudio.dynamicSources.task609.test.ts`,
`useArcaAudio.muteAllSources.task609.test.ts`,
`useArcaAudio.sources.task597.test.ts`, `useArca.audio-unification.test.ts`,
`useArcaAudio.stopOrder.task597.test.ts`)

Scope note: `store.activeStream` is unaffected by `removeSource` (pre-existing
behavior — removal from the mixer never implied an `activeStream` change), so
the mute-cycle test targets a secondary source (`micB`) specifically; that is
intentional, not a gap in the fix.

### 3. Reference app: capture-first start order (`apps/quick-compat-app/src/components/LiveTranscription.tsx`)

- `useAudioCapture(...)` gained `options: { sttPipelineId: pipelineId.trim() || undefined }` (previously called with no `options` at all).
- `start()` now calls `await capture.startRecording()` before
  `await stt.startTranscription()` (previously the reverse).
- The comment justifying STT-first (claiming only `useArcaSpeechToText`
  carries a pipeline id) was replaced with one stating capture-first is
  correct because `useAudioCapture` is the only hook carrying device/source
  options, both hooks pass `pipelineId` so provider switching is set either
  way, and `language`/`languageMode`/`pendingSttProvider` are store-backed
  and therefore order-independent.

Verified by reading `useAudioCapture.ts` (`startRecording()` calls
`audio.start({ pipelineId: options?.sttPipelineId, ... })`) that
`options.sttPipelineId` reaches `audio.start` the same way the STT hook's
`options.pipelineId` does — so the flip does not regress pipeline/provider
selection.

Unrelated pre-existing content in the file (the `console.log('REceived: '
+ text)` typo in `onTranscript`, the `sessionId: ''` comment, the
synchronous-mic-release comment on `stop()`, all JSX) was left untouched.
This component only consumes `onTranscript(text, isFinal)` — it never
touches `captureStartMsRef` or other timeline-anchor internals — so item 1
above is transparent to it; no second start-order-shaped defect was found
here.

`apps/quick-compat-app` is not part of the pnpm workspace (external
developer test app, per prior session notes) — its own `tsc --noEmit` was
run directly rather than via `pnpm --filter`.

### Files changed

| File | Change |
|---|---|
| `packages/agentic-sdk-v2/src/compat/useArcaSpeechToText.ts` | New capture-transition anchor effect; STT-first pre-anchor kept as-is; one comment amended |
| `packages/agentic-sdk-v2/src/compat/__tests__/useArcaSpeechToText.timelineAnchor.task611.test.ts` | New, 6 tests |
| `packages/agentic-sdk-v2/src/hooks/useArcaAudio.ts` | `sourceIdToStreamRef`, populated at both id-mint sites, reset at all three reset points, consumed in `removeSource` |
| `packages/agentic-sdk-v2/src/hooks/__tests__/useArcaAudio.removeSourceCleanup.task611.test.ts` | New |
| `apps/quick-compat-app/src/components/LiveTranscription.tsx` | `useAudioCapture` gains `options.sttPipelineId`; start order flipped to capture-first; comment corrected |

## Verification

```
$ cd packages/agentic-sdk-v2 && npx vitest run
Test Files  237 passed (237)
     Tests  3895 passed (3895)

$ pnpm --filter @arcaai/vox typecheck   → PASS (tsc --noEmit, no output)

$ pnpm --filter @arcaai/vox lint       → PASS, 0 errors, 3 warnings
  (all pre-existing eslint-comments/no-unlimited-disable: useArcaConfig.ts:269,
   AgenticProvider.tsx:679, AgenticProvider.tsx:874 — unrelated to this ticket)

$ pnpm --filter @arcaai/vox build      → PASS (ESM/CJS core + index bundles, dts build)

$ cd apps/quick-compat-app && npm run typecheck   → PASS (tsc --noEmit, no output)

$ cd apps/quick-compat-app && npm run build       → PASS (vite build, 112 modules transformed)
```

`apps/quick-compat-app` has no `lint` script and no test files for
`LiveTranscription.tsx`; typecheck and build are the only gates available for
that app.

Not verified at runtime against a live gateway: the reference app's actual
transcript behavior after the start-order flip (i.e. confirming attribution
is correct end-to-end with real audio, not just via the SDK's unit-level
mock). Owner check — run the compat playground, start a session, and confirm
delivered finals are attributed to the metadata bag active at the time they
were spoken.

## Known limitations

None identified beyond the runtime-verification gap noted above.

## Change History

| Date | Change |
|---|---|
| 2026-08-04 | Ticket opened and implemented: capture-transition timeline anchor in `useArcaSpeechToText`, `removeSource` stream-registry cleanup in `useArcaAudio`, reference app flipped to capture-first start order with corrected comment. New tests: 6 (timeline anchor) + 1 file (`removeSourceCleanup`, exact count not separately reported). Full SDK suite (237 files / 3895 tests), typecheck, lint (0 errors / 3 pre-existing warnings), and build green; `quick-compat-app` typecheck and build green (no lint/test scripts exist for that app). |
