# BUG-026 — Live Transcription: duplicate "Start session" buttons in idle state

- **Status:** Review
- **Type:** bugfix (UI)
- **Source:** https://github.com/ArcaAI/project-hope/issues/26 (JayaramNambiar, 2026-09-30; labels `bug`, `Playground`)
- **Severity:** Low

## Requirement Analysis

At `/playground/live-transcription` (Streaming session tab, no active session), two identical "Start session" buttons render: one in the page header (top right) and one in the "No live session" empty state. Expected: a single primary CTA in the idle state. Reporter suggests removing the header one. Video: https://github.com/user-attachments/assets/db5b9226-4263-421d-ae97-ee22d311b8d8

## Current State Evaluation

- Header action: `apps/admin-console/src/features/playground-live-transcription/components/live-transcription-screen.tsx:113-127` — `busy ? <Stop session/> : <Start session/>` (`handleStart`, line ~97).
- Empty state action: `.../components/streaming-tab.tsx:336-345` (`live.status === 'idle' && !hasTranscripts`) renders the same `<Button onClick={onStart}>Start session</Button>`.
- A third Start button exists at `streaming-tab.tsx:350-358` for the "idle with previous transcript" state, where the header button is ALSO shown, so the duplication occurs there too (the header never hides in idle).
- Header also holds Stop while busy, so the header button is the only control that spans all states; the empty-state/previous-session buttons are the redundant ones. Both buttons share `canStart`.
- Last touched by TASK-1048 / TASK-985 (`git log` on streaming-tab.tsx); not fixed on dev-2.2. No related ticket in docs/implementation or docs/archive.

## Root Cause

Two independently authored idle CTAs (header in `live-transcription-screen.tsx`, empty-state and previous-session in `streaming-tab.tsx`) are both rendered when `status === 'idle'`. Confidence: high.

## Implementation Plan

TDD:
1. Extend the live-transcription screen test: in idle (no transcripts) exactly one button named "Start session" (`getAllByRole('button', {name: /start session/i})` length 1); same for idle with previous transcript; while busy exactly one "Stop session".
2. Test that the remaining Start button is disabled with a visible reason when no tenant (rule 11 §5), if that behaviour is retained.

File order:
1. Decision (see below), then either (A) remove the header Start (keep header Stop when busy) in `live-transcription-screen.tsx`, or (B, recommended by rule 11 §1 "pinned header actions") keep the header Start and drop the buttons inside `EmptyState` (`streaming-tab.tsx:340-344`) and the previous-session row (`:350-358`), leaving the explanatory text.
2. Update tests under `.../components/__tests__/` for both files.

Verification: `pnpm --filter @arcaai/admin-console test <changed test files>`, `pnpm admin:typecheck`, `pnpm admin:lint`; orchestrator headed check of idle, running, previous-transcript states in both themes.

## Risks / Open Questions for the owner

- Which button survives? Reporter says drop the header one; design rule favours a stable pinned header action (also holds Stop while running). A keyboard/a11y consideration: an empty-state CTA is the more discoverable one, the header one is consistent across states. Owner picks A or B.
- Error and quota panels call `onStart` as "restart"; unaffected.

## Implementation Summary

Decision (owner, 2026-10-11): keep the in-panel controls, drop the header Start (option A). While writing the RED test a second duplicate surfaced: while streaming, the header's Stop session duplicated the session controls card's own Stop (`streaming-tab.tsx:200`). Under the same decision the header action was removed entirely, so the streaming tab owns both controls.

- `apps/admin-console/src/features/playground-live-transcription/components/live-transcription-screen.tsx` — `CanvasHeader` has no `actions`; removed the now-unused `handleStop` and the two player icon imports.
- `.../components/__tests__/live-transcription-screen.test.tsx` — two tests: idle shows exactly one Start session and no Stop; streaming shows exactly one Stop and no Start; after stopping with a transcript, exactly one Start and no Stop.

Evidence:
- RED: both new tests failed (2 Start buttons idle; 2 Stop buttons streaming).
- GREEN: `vitest run src/features/playground-live-transcription/components/__tests__/` → 3 files, 35 tests passed.
- `tsc --noEmit` (admin-console) exit 0; `eslint` on both changed files exit 0.
- Running console (`stack:dev -- api admin`, tenant_admin @ Global): Streaming tab idle → 1 Start (empty state), 0 Stop, no header action, no console errors; Batch upload tab → 0 Start. Streaming itself not exercised in the browser pane (mic blocked there); covered by the unit test.

## Change History

- 2026-10-06 — Ticket created from GitHub issue #26 (read-only investigation).
- 2026-10-11 — Fixed (option A + header Stop removed); tests, typecheck, lint, live console check green. Status Review.
