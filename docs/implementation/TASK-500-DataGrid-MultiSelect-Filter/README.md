# TASK-500 — Data-grid multi-select filter collapses to zero rows

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Area** | `packages/ui` (`@arcaai/ui`) — `components/data-grid` |
| **Reported by** | Manual test — admin app, `super_admin`, issue #1 |
| **Related** | Commit `57e04574c` (multi-select rollout across admin screens) |

## Requirement Analysis

A faceted `multiSelect` filter must allow **more than one value active at once** on any
screen. Selecting a second value must widen (OR) the result set, never clear it.

Reported symptom: "cannot select more than 1 filter in the filter controller in any
interfaces." Investigation shows the selection UI is actually fine — the badge count
increments and both checkboxes show checked — but the **visible result set collapses to
zero rows** the instant a second value is added, which reads to the user as "the filter
broke / only one filter allowed."

Acceptance criteria:
- On a client-side grid, selecting two values in a `multiSelect` facet returns the union
  of matching rows (not an empty grid).
- Server-driven grids (`AdminDataGrid`, `manual.filtering: true`) keep working unchanged.
- A regression test asserts the **row model**, not just the emitted `FilterRule`.

## Current State Evaluation

**Root cause (live-reproduced in `packages/ui` Storybook — `Custom/DataGrid → Fill Height`, "Plan" column):**

- Selection/state handling is correct:
  - `data-grid-faceted-filter.tsx` → `OptionChecklist.apply()` builds `{ operator: 'inArray', value: [...] }` and adds to the selection.
  - `use-data-grid.ts` → `setFilter()` upserts by column id correctly. Value model is already an array (`FilterRule.value: string[]`).
- **The bug**: `use-data-grid.ts` passes `columns` straight into `useReactTable({ data, columns })` with **no `filterFn` injection**. A `multiSelect` column that does not explicitly set `filterFn` falls back to TanStack's default `includesString`:
  - one value → `filterValue = ['FREE']` → `String(['FREE']) === 'FREE'` → substring match works.
  - two values → `filterValue = ['FREE','PRO']` → `String(['FREE','PRO']) === 'FREE,PRO'` → `'free'.includes('free,pro') === false` for **every** row → grid shows "No results".
- An array-aware helper already exists — `filter-controls.ts` → `includesSomeFilter` — but it is **opt-in per column** (`filterFn: includesSomeFilter` on each `ColumnDef`), so it is easy to forget.

**Blast radius (audited all 10 `multiSelect` screens):**

| Grid mode | Screens | Exposed? |
|---|---|---|
| `AdminDataGrid` server-driven (`manual.filtering`) | ai-models, api-keys, audit-logs, settings, tenants-list, users-list | No — gateway does `field[in]:a\|b` |
| Raw `VirtualizedDataGrid` client-side **with** explicit `filterFn: includesSomeFilter` | queues, schedulers (×2), tenant-storage (×3) | No — opted in |
| Raw `VirtualizedDataGrid`, external `.includes()` filtering | audio-pipelines | No — bypasses TanStack |

No shipped screen hits it *today*, but only because 3 of 9 client-side facets remembered the manual opt-in (in the same commit that introduced it). It is a systemic footgun: any new `multiSelect` facet on a client-side grid, any Storybook/dev grid, or a regression dropping `filterFn`, reproduces it immediately.

## Implementation Plan

TDD — RED first.

1. **Failing test** — `packages/ui/src/components/data-grid/__tests__/data-grid.vitest.tsx`:
   render a `VirtualizedDataGrid` in **client-side** mode (uncontrolled, no `manual.filtering`) with a `multiSelect` column that declares **no** `filterFn`; call `setFilter` for value A, then value B; assert `table.getFilteredRowModel().rows.length > 0` and that the rows are the union of A ∪ B. (Existing test at lines 80–87 only checks the emitted `FilterRule` — that is exactly the gap.)

2. **Fix** — `packages/ui/src/components/data-grid/use-data-grid.ts`: before handing columns to `useReactTable`, resolve a default filterFn for multi-select columns that don't set one:
   ```ts
   const resolvedColumns = useMemo(
     () => columns.map((col) =>
       col.meta?.variant === 'multiSelect' && !col.filterFn
         ? { ...col, filterFn: includesSomeFilter }
         : col,
     ),
     [columns],
   );
   ```
   Pass `resolvedColumns` to `useReactTable`. Explicit per-column `filterFn` still wins, so the 3 opted-in screens are unaffected.

3. **No URL/nuqs change** — `grid-url-state.ts` already serializes arrays (`inArray → field[in]:a|b`) for the server path; this touches only the client-side `getFilteredRowModel()` path.

4. **Verify** in Storybook: Plan filter → FREE (rows shown) → +PRO → union of rows shown (not empty).

### File change order
1. `__tests__/data-grid.vitest.tsx` (RED)
2. `use-data-grid.ts` (GREEN)

## Enhancement / Improvement (optional, out of default scope)

- **Centralize variant→filterFn resolution** for all faceted variants (`range`, `date`, boolean) in the same `resolvedColumns` map, so no client-side variant can silently fall back to `includesString`.
- **Remove the now-redundant manual `filterFn: includesSomeFilter`** opt-ins in `queues-screen.tsx`, `schedulers-screen.tsx`, `tenant-storage-screen.tsx` once the default lands (surgical cleanup — leave unless explicitly requested).

## Verification Criteria

- [x] New test fails before the fix, passes after (watched RED→GREEN).
- [x] `pnpm --filter @arcaai/ui build lint test` green.
- [ ] Storybook: two-value `multiSelect` selection shows the union of rows; single value unchanged; server-driven `AdminDataGrid` unchanged. (not run interactively this pass — covered by the new headless-controller test exercising the identical `getFilteredRowModel()` path)

## Implementation Summary

Fix landed exactly per plan, no deviations.

- **Test** (`packages/ui/src/components/data-grid/__tests__/data-grid.vitest.tsx`): added a case to the existing `useDataGrid (headless controller)` describe block — client-side `useDataGrid` with the `status` `multiSelect` column (no `filterFn` declared), `setFilter` to `['ACTIVE']` then `['ACTIVE','ARCHIVED']`, asserting `table.getFilteredRowModel()` row ids each time. RED confirmed first: `expected [] to deeply equal ['p0','p1','p2','p3']` (the 2-value case collapsed to zero rows, matching the reported bug).
- **Fix** (`packages/ui/src/components/data-grid/use-data-grid.ts`): added a `resolvedColumns` memo that maps `multiSelect` columns with no explicit `filterFn` to `includesSomeFilter` (already existed in `filter-controls.ts`, previously opt-in only); `useReactTable` now receives `resolvedColumns` instead of the raw `columns` prop. Explicit per-column `filterFn` still wins (map only touches columns missing one), so the 3 already-opted-in screens (queues, schedulers ×2, tenant-storage ×3) are unaffected.
- No changes to `grid-url-state.ts` / server-driven (`manual.filtering`) path, as scoped.

**Files changed:**
- `packages/ui/src/components/data-grid/use-data-grid.ts` — default `filterFn` resolution for `multiSelect` columns.
- `packages/ui/src/components/data-grid/__tests__/data-grid.vitest.tsx` — regression test on the row model.

**Evidence:**
- RED: `AssertionError: expected [] to deeply equal [ 'p0', 'p1', 'p2', 'p3' ]` (pre-fix run of the new test).
- GREEN: `pnpm --filter @arcaai/ui test -- data-grid.vitest` → `Test Files 1 passed (1)`, `Tests 37 passed (37)`.
- Full gate: `pnpm --filter @arcaai/ui build lint test` → build succeeds (pre-existing unrelated `import.meta`/"use client" bundler warnings only), `eslint src --max-warnings 0` clean, full suite `242 passed (242)` / `656 passed (656)`.
- `pnpm --filter @arcaai/ui check-types` has pre-existing, unrelated failures (missing `vitest-axe`/`@testing-library/user-event` ambient types, storybook `args` typing, generic `MasterDetailColumnDefinition<unknown>` narrowing) across files this change never touches — not part of this ticket's Definition of Done (`build lint test`) and not introduced by it.

## Change History

| Date | Change |
|---|---|
| 2026-07-12 | Ticket created from manual-test issue #1; root cause live-reproduced in Storybook. |
| 2026-07-12 | Implemented: TDD RED→GREEN, `includesSomeFilter` wired as the default `filterFn` for unopted `multiSelect` columns in `use-data-grid.ts`. `build lint test` green for `@arcaai/ui`. Status → Review. |
