# BUG-002 — Agents screen stacks a new "Versions" card on every template selection

| Field | Value |
|---|---|
| Status | Completed |
| Type | bugfix |
| App | `apps/admin-console` (Next.js 16.3.0-preview.5, React 19.2.7) |
| Screen | Frame 32 — Agents & Prompt Templates (`/agents`) |
| Related | TASK-415 (Hope Admin Console) |

## Requirement Analysis

On the Agents & Prompt Templates screen, clicking a template row is supposed to
load that template into the left "Versions" panel and the right "Test run"
panel. Instead, every selection change **added one more "Versions" card** to
the page — after clicking through a few templates the grid's first row showed
three stacked Versions cards (see
`evidence/01-before-stacked-version-cards.png`) and the table/test-run panels
were pushed into the next grid row. The stale cards kept the previously
selected template's data and never went away short of a full page reload.

## Current State Evaluation (root cause)

`AgentsScreenBody` renders the three-column grid with **two keyed siblings
that used the same key value** — both panels were keyed by the selected
template id:

```tsx
<div className="grid ...">
    {selected ? <VersionsPanel key={selected.id} ... /> : <Card>...</Card>}
    <div>{/* templates DataTable */}</div>
    {selected ? <TestRunPanel key={selected.id} ... /> : <Card>...</Card>}
</div>
```

React requires keys to be **unique among all siblings of the same parent**.
`VersionsPanel` and `TestRunPanel` are direct siblings of the grid `div`, so
both carried e.g. `key="pt-1"`. During keyed reconciliation
(`reconcileChildrenArray`), React builds a `Map` of the remaining old children
keyed by `fiber.key` — `Map.set` silently **overwrites** the first colliding
entry (the old `VersionsPanel`) with the second (`TestRunPanel`). When the
selection changes (`pt-1` → `pt-2`):

1. The prefix walk breaks immediately (keys differ).
2. The map contains only `{"pt-1": TestRunPanel, 1: table div}`; the old
   `VersionsPanel` fiber was overwritten out of the map.
3. New panels mount, the table div is reused, and end-of-pass deletions only
   cover what is *left in the map* — the old `TestRunPanel`.
4. The old `VersionsPanel` is **never scheduled for deletion**: its fiber is
   orphaned and its DOM node stays on the page. One extra Versions card per
   selection change.

This is the documented consequence of duplicate keys ("Non-unique keys may
cause children to be duplicated and/or omitted"); React dev builds also log
`Encountered two children with the same key` on `/agents`.

Why tests missed it: the existing "loads the clicked row into the versions
panel" test asserted the *new* panel appeared but never asserted the *old*
panel was unmounted, and no assertion counted the panels.

Scope audit: the other screens that key side panels by selection
(`departments-screen.tsx`, `dna-writing-styles-screen.tsx`,
`audio-pipelines-screen.tsx`) each have only **one** keyed child per parent —
no collision, not affected.

## Implementation Plan

TDD (regression-first):

1. RED — extend `agents-screen.test.tsx` with a selection-cycling test that
   asserts the previous panels unmount and exactly one Versions panel and one
   Test run panel exist after multiple row clicks.
2. GREEN — prefix the sibling keys so they are unique:
   `key={`versions-${selected.id}`}` / `key={`test-run-${selected.id}`}`
   (keyed remount behaviour — panel-local state resetting on selection — is
   preserved).
3. Gates — package test suite, lint, type-check; runtime verification against
   the running dev app.

## Implementation Summary

Files changed:

| File | Change |
|---|---|
| `apps/admin-console/src/features/agents/components/agents-screen.tsx` | Unique sibling keys: `versions-${id}` for `VersionsPanel`, `test-run-${id}` for `TestRunPanel`, plus an explanatory comment |
| `apps/admin-console/src/features/agents/components/__tests__/agents-screen.test.tsx` | New regression test `replaces the side panels on selection change instead of stacking version cards (BUG-002)` |

No API, database or dependency changes.

### Verification Evidence

RED — the new test fails against the pre-fix code (orphaned panel still in the DOM):

```
❯ src/features/agents/components/__tests__/agents-screen.test.tsx:242:73
  expect(screen.queryByLabelText('Versions of Cardiology Notes')).toBeNull()
Test Files  1 failed | 74 passed (75)
      Tests  1 failed | 503 passed (504)
```

GREEN — full package suite after the fix:

```
Test Files  75 passed (75)
      Tests  504 passed (504)
```

`pnpm --filter @arcaai/admin-console lint` (eslint, `--max-warnings 0`) and
`check-types` (tsc) both pass cleanly.

Runtime — driven browser against `pnpm dev:admin` (port 5176), working tenant
«Global», clicking through 4 template rows and counting cards after each click:

```
[{"clickedRow":1,"name":"Breast & Endocrine - Revisit","versionCards":1,"testRunCards":1},
 {"clickedRow":2,"name":"Cardiology Department Prompt","versionCards":1,"testRunCards":1},
 {"clickedRow":3,"name":"Catch-All SOAP","versionCards":1,"testRunCards":1},
 {"clickedRow":4,"name":"Corrective Retry Suffix","versionCards":1,"testRunCards":1}]
```

Screenshots: `evidence/01-before-stacked-version-cards.png` (bug),
`evidence/02-after-single-version-card.png` (fixed layout).

## Change History

| Date | Change |
|---|---|
| 2026-07-05 | Ticket opened from user report (screenshot of three stacked Versions cards). Root cause traced to duplicate React keys on sibling panels; regression test added (RED), keys prefixed (GREEN), suite/lint/tsc green, fix verified in the running dev app. Status: Completed. |
