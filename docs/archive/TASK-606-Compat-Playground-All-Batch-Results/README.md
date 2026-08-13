# TASK-606 — Compat playground: "all results" view for batch upload

| Field | Value |
|---|---|
| **Status** | `Review` |
| **Type** | `feature` |
| **Branch** | `dev-2.1` |
| **Packages** | `@arcaai/compat-playground` |
| **Depends on** | TASK-603 (compat batch upload — `useArcaBatchTranscription`, `BatchJobQueue`, `BatchJobResult`) |
| **Related** | BUG-015 (STT worker cross-event-loop singletons) — surfaced live during verification of this ticket as a `failed` item in the new view; pre-existing, not caused or fixed here |

---

## Requirement Analysis

The batch tab (TASK-603) can only show ONE transcript at a time — whichever queue item
is selected via `batch.select(item.id)`. A user who drops ten files has to click through
them one at a time to read, scan, or export every result.

Add a view that lists ALL results together, in one scrollable surface, without removing
the existing master–detail (queue + single-result) flow. Requirements set by the ticket:

1. An "all results" view listing every item's transcript, headed by file name + status
   badge + job id, in queue order.
2. Keep the existing single-result detail view working; let the user switch between the
   two — do not silently delete the master–detail flow.
3. Handle mixed states honestly: a still-processing item shows its streaming text so far
   (or a `<Skeleton />`, never a spinner), a failed item shows its error, a cancelled item
   says so. Nothing is hidden from the list.
4. Bulk affordances: copy-all and/or download-all as text, plus a per-item copy. Keep
   "send to summarization" reachable.
5. A count summary (e.g. "7 of 10 completed").
6. House UI rules: `Skeleton` for loading, `Spinner` only inside in-flight buttons (none
   needed here — no in-flight submit actions), `toast.success`/`toast.error` on actions,
   semantic tokens only, long transcripts scroll in their own container, one `h1` per
   page (unaffected — this is a sub-view, no new heading), icon-only controls carry
   `aria-label` (none added — every control here is text-labelled), visible focus ring,
   both themes.

Scope is `apps/compat-playground/` only. `useArcaBatchTranscription` (`@arcaai/vox/compat`)
is a fixed API — read, not modified.

---

## Current State Evaluation

`apps/compat-playground/src/components/batch/`:

- `BatchUploadPanel.tsx` — drop zone, pipeline/language/concurrency controls, clear queue.
- `BatchJobQueue.tsx` — one row per file; clicking the file name calls `batch.select(item.id)`;
  the selected row gets a primary border + `aria-pressed`. Owns `STATUS_VARIANT`/`STATUS_LABEL`
  (not exported before this ticket).
- `BatchJobResult.tsx` — renders ONLY `batch.items.find(i => i.id === batch.selectedId)`:
  segments while streaming, `item.text` + "send to summarization" once `completed`,
  "Nothing selected." when nothing is picked.
- `context/playground-session.tsx` (`PlaygroundBatchSlice`, ~L406–444) — owns `selectedId`/
  `select`, wraps `useArcaBatchTranscription`, and already keeps the batch queue mounted
  above the tabs so an upload survives a tab switch.

`BatchQueueItem` (`packages/agentic-sdk-v2/src/compat/useArcaBatchTranscription.ts`, read-only
for this ticket): `{ id, fileName, size, status, uploadProgress, jobId, segments, text, error,
job }`, `status ∈ {pending, uploading, processing, completed, failed, cancelled}`. `item.text`
is the joined FINAL segments while streaming and the job's authoritative `resultText` once
`completed` — already exactly the value both the single view and the new bulk actions need,
with no extra derivation required.

No existing test file covered `BatchJobResult`/`BatchJobQueue` directly — they were exercised
through the integration-style `components/__tests__/BatchUploadTab.test.tsx`, which mocks
`useArcaBatchTranscription` and drives the tab through the real `<App />`. That is the pattern
this ticket's new tests follow, rather than introducing a second, isolated test style.

---

## Implementation Plan

1. **`BatchAllResultsView.tsx`** (new) — the list. One block per item (file name, status
   badge, job-id badge, then a status-specific body): failed → error text; cancelled →
   "Cancelled."; waiting (pending/uploading/processing-with-no-text-yet) → `Skeleton`
   triplet; otherwise → `item.text` in a scrollable `<pre>` + per-item "Copy" (+ "Send to
   Summarization" only once `completed`, same restriction `BatchJobResult` already applies).
   A header row above the list carries the "N of M completed" count and "Copy all"/
   "Download all". Exports `buildBatchResultsText(items)` — the shared plain-text
   serialization (`=== fileName (Status, job id) ===` + body) used by both bulk actions,
   so "download" and "copy" can never drift from each other.
2. **`BatchResultsPanel.tsx`** (new) — a small stateful wrapper: two text-labelled toggle
   buttons ("Selected file" / "All results", `aria-pressed`, same pattern the queue row's
   select button already uses) switch between the EXISTING `<BatchJobResult />` and a
   `<Card>` wrapping the new `<BatchAllResultsView />`. Defaults to `selected` — dropping
   one file reads exactly as before; only one of the two is ever mounted, so there is never
   a second `Card` header stacked on the single view's own header.
3. **`BatchJobQueue.tsx`** — export `STATUS_VARIANT`/`STATUS_LABEL` (already existed,
   previously module-private) so the all-results view uses the identical status vocabulary
   instead of a second copy.
4. **`BatchUploadTab.tsx`** — swap `<BatchJobResult />` for `<BatchResultsPanel />`; no other
   change.
5. Tests (TDD): extend `components/__tests__/BatchUploadTab.test.tsx` (same mocking
   posture as the existing suite) — RED first, then the implementation above.

No `packages/` or `apps/admin-console` changes; no new dependencies (icons and bulk-clipboard
helpers already usable through the codebase are either plain-text buttons — matching this
app's existing icon-free button style — or `navigator.clipboard`/`Blob`, the exact pattern
`ScorecardPanel.tsx`'s JSON export already uses).

---

## Implementation Summary

| File | Change |
|---|---|
| `apps/compat-playground/src/components/batch/BatchAllResultsView.tsx` | **New.** `buildBatchResultsText(items)` (exported, shared serialization) + `BatchAllResultsView` (count summary, Copy all / Download all, per-item `ResultBlock` with skeleton/error/cancelled/text branches, `data-testid="batch-all-results"`). |
| `apps/compat-playground/src/components/batch/BatchResultsPanel.tsx` | **New.** Toggle between `BatchJobResult` (default) and a `Card`-wrapped `BatchAllResultsView`. |
| `apps/compat-playground/src/components/batch/BatchJobQueue.tsx` | `STATUS_VARIANT`/`STATUS_LABEL` changed from module-private `const` to `export const` — reused by the new view, nothing else changed. |
| `apps/compat-playground/src/components/BatchUploadTab.tsx` | `<BatchJobResult />` → `<BatchResultsPanel />` in the right-hand column; import updated to match. |
| `apps/compat-playground/src/components/__tests__/BatchUploadTab.test.tsx` | 8 new tests under `describe('All-results view (TASK-606)', ...)`: default view, listing every item in queue order, switching views round-trip, all 5 mixed statuses rendering their correct affordance (nothing hidden), "Send to Summarization" reachable from the all-results view, copy-all, download-all, per-item copy. |

No changes to `packages/agentic-sdk-v2`, `apps/stt`, `apps/api`, or `apps/admin-console`.

---

## Verification

TDD: all 8 new tests written first and confirmed RED (`getByRole` "Selected file"/"All
results" not found, `navigator.clipboard`/`URL` stubbing issues surfaced and fixed —
see notes below), then the implementation above turned them GREEN with no changes to the
7 pre-existing tests in the same file.

**Test-writing notes worth recording** (so a future reader isn't surprised by the test
file's shape):
- happy-dom's `navigator.clipboard` is a real, lazily-recreated `Clipboard` instance —
  replacing it wholesale with `Object.defineProperty` before `render()` does not survive
  to the click. The fix (matching no prior precedent in this file, but the standard
  Vitest/happy-dom pattern) is `vi.spyOn(navigator.clipboard, 'writeText')` called AFTER
  `render()`+navigation, spying on the method instead of replacing the object.
- The "download all" test needed `vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})`,
  the same stub `ScorecardPanel.test.tsx`'s export test already uses — happy-dom's anchor
  `click()` attempts a real navigation once `href` is set, which throws against a stubbed
  `URL` global otherwise.

**`pnpm --filter @arcaai/compat-playground test`:**
```
 Test Files  20 passed (20)
      Tests  218 passed (218)
```
(210 pre-existing + 8 new; no regressions.)

**`pnpm --filter @arcaai/compat-playground lint`:** clean (one prettier formatting warning
on the new `ResultBlock` prop-destructure fixed inline; `--max-warnings 0` passes).

**`pnpm --filter @arcaai/compat-playground typecheck`:** clean (`tsc --noEmit`, no output).

**Manual runtime verification — a real browser against a live backend, not just tests.**
The app's own `vite` dev server (port 5177, already running before this session — not
started or restarted for this ticket) was connected to the ALREADY-RUNNING local API
gateway (`:8868`) and STT service/worker. Two real files
(`apps/compat-playground/public/mltest/test-1.wav`, `test-2.wav`) were queued through the
real `useArcaBatchTranscription` hook (files injected via `input.files` + a `change`
event — the file-picker dialog itself is outside what a driven browser can open — then
watched run for real through upload → processing → terminal state):

- The toggle rendered "Selected file" (pressed, default) / "All results", exactly as
  planned; toggling to "All results" with an empty queue showed "No files queued yet."
- With two real jobs queued: `test-2.wav` reached `Completed` with its real transcript
  text (Malayalam) rendered in the scrollable block, "Copy" and "Send to Summarization"
  present; `test-1.wav` reached `Failed`, rendering its real error text in `text-destructive`
  — this error is BUG-015 (STT worker cross-event-loop singletons, status `Review`,
  already tracked), reproduced live and NOT something this ticket introduces or fixes.
  While `test-2.wav` was still `processing` with no text yet, its block showed the
  `Skeleton` triplet, never a spinner.
- Count summary read "0 of 2 completed" then "1 of 2 completed" as `test-2.wav` finished.
- "Copy" (per-item), "Copy all", and "Download all" were each clicked for real: the
  clipboard write succeeded (confirmed via the app's own `toast.success` — "Copied
  test-2.wav.", "Copied every transcript to the clipboard.") and the download flow ran
  end to end ("Downloaded every transcript."). "Send to Summarization" from the
  all-results view was clicked and confirmed by switching to the Summarization tab: its
  transcript textarea contained the exact real transcript text and the source selector
  read "Pasted".
- Dark theme was what the app opened in (verified above); light theme and a full
  keyboard-only pass were NOT separately exercised in this session — see Left Out below.

---

## Left out / deliberately not done

- **Light theme and keyboard-only pass were not manually re-verified** beyond the
  automated dark-theme browser run above. Nothing in the new components hardcodes a
  color or a mouse-only interaction (plain `Button`s, semantic tokens throughout,
  identical pattern to the pre-existing `BatchJobResult`/`BatchJobQueue`), so this is a
  low-risk gap, not a known defect.
- **No axe/accessibility-scan automation was added** for this specific view (the app has
  no existing axe-scan test harness to extend into). Manual review: every control is a
  real, text-labelled `<button>`, focus rings are the shared `Button` component's default,
  and no color-only status indication was introduced (status is always spelled out in
  text, matching `BatchJobQueue`'s existing convention).
- **BUG-015 (the cross-event-loop worker bug) was observed but not touched** — it is
  someone else's already-open, already-diagnosed ticket; fixing it was out of scope here
  and the scope boundary for this task excluded `apps/stt`.

## Decisions the user may want to overrule

- **Default view is "Selected file", not "All results".** This keeps the pre-existing
  single-drop UX byte-for-byte identical (and is why none of the 7 pre-TASK-606 tests in
  `BatchUploadTab.test.tsx` needed changing). An argument could be made for defaulting to
  "All results" instead, since that is the primary reason this ticket exists — but that
  would mean a batch of one file no longer opens straight into its own transcript.
- **The bulk export format is a simple `=== file (Status, job id) ===` / body text block**,
  not JSON or CSV. This matches "copy/download as text" from the ticket and mirrors what a
  user would paste into a document; it is not a machine-parseable format like
  `ScorecardPanel.tsx`'s JSON export.
- **"Copy"/"Send to Summarization" for a still-processing item only appears once there is
  ANY non-empty text** (streamed partial included), not only once `completed` — this
  matches `item.text`'s own documented semantics (joined finals while streaming), but
  widens "Send to Summarization" slightly beyond `BatchJobResult`'s stricter
  `completed`-only gate for that specific button. Copy is available whenever there is
  text of any kind; Send to Summarization stays `completed`-only, same as before.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-03 | **Ticket created and implemented in one pass.** Added `BatchAllResultsView` (all-items list, count summary, bulk copy/download, per-item copy) and `BatchResultsPanel` (toggle wrapper defaulting to the pre-existing selected-file view), wired into `BatchUploadTab`. TDD: 8 new tests RED → GREEN, 210 pre-existing tests unaffected. `test`/`lint`/`typecheck` all green. Manually verified live against the running local gateway + STT worker with two real audio files — completed, failed (BUG-015, pre-existing, untouched), and processing/skeleton states all observed for real, plus real clipboard copy, download, and hand-off to Summarization. |
