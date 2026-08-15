# TASK-703 — TanStack Table 9 VirtualizedDataGrid Rewrite

| Field | Value |
|---|---|
| **Status** | `Completed` |
| **Type** | `refactor` |
| **Ticket number** | TASK-703 |
| **Classification** | Full `@tanstack/react-table` v8 → v9 rewrite for `VirtualizedDataGrid` (not a floor bump; not `useLegacyTable`) |

---

## Requirement Analysis

TASK-699 reverted `@tanstack/react-table` 9.1.2 after `useLegacyTable` crashed `table.getHeaderGroups()` (`Cannot read properties of undefined (reading 'length')`). 27 data-grid tests failed. The legacy adapter is not a viable path.

This ticket ports `packages/ui` to the real v9 model:

- `useReactTable` → `useTable`
- Register capabilities with `tableFeatures()` (row models, filter/sort fns)
- Update `ColumnDef` / `Table` / `Row` / `Header` generics to include `TFeatures`
- Header groups, column pinning (`left`/`right` → `start`/`end`), and the row virtualizer must stay green
- Do not ship mixed v8 types with a v9 runtime
- Keep React **19.2.8**. Do not bump TypeScript, pdfjs, Vite, BullMQ, ioredis, or openid-client
- Own `pnpm-lock.yaml` only (no `uv.lock`, no Temporal compose)

Success: `pnpm --filter @arcaai/ui test` green on **9.1.x**. If the rewrite cannot finish, revert the version bump and leave v8 + documented remaining files.

---

## Current State Evaluation

- `@tanstack/react-table` is now `^9.1.2` in `packages/ui/package.json` (only direct consumer); lockfile pins `9.1.2`
- Canonical grid uses `useTable` + shared `dataGridFeatures` (`tableFeatures(...)`)
- `@arcaai/ui` still exports a one-arg `ColumnDef<TData>` alias
- Persisted v8 `{ left, right }` pinning is normalized to v9 `{ start, end }`
- React workspace override remains **19.2.8**

---

## Implementation Plan

1. **RED (behavior lock, still on v8):** add tests that `getHeaderGroups()` returns one header per visible leaf column, that rendered `columnheader` cells match, and that the virtualizer `count` equals `displayRows.length` with a bounded DOM window.
2. Verify those tests pass on v8.
3. Bump `@tanstack/react-table` → `^9.1.x` and `pnpm install` (refresh `pnpm-lock.yaml`).
4. Introduce a shared `dataGridFeatures` + `ColumnDef<TData>` alias; rewrite `useDataGrid` / `useDataTable` to `useTable`.
5. Port pinning, `table.getState()` → `table.state`, module augmentation generics, and diceui types.
6. **GREEN:** `pnpm --filter @arcaai/ui test`. Revert the bump if red and the rewrite is incomplete.

---

## Implementation Summary

**Result: landed on v9.1.2.** Not `useLegacyTable`. `pnpm --filter @arcaai/ui test` is green.

Behavior-lock tests (written on v8 first, then kept on v9):

- `getHeaderGroups returns one header per visible leaf column (v9 port lock)`
- `renders columnheaders from header groups without crashing`
- `virtualizer count matches displayRows (v9 port lock)`

Port notes:

- `useReactTable` → `useTable({ features: dataGridFeatures, ... })`
- Row models registered via `createFilteredRowModel` / `createSortedRowModel` / `createPaginatedRowModel` / faceting factories
- `table.getState()` → `table.state`
- Pinning `left`/`right` → `start`/`end`; `normalizeColumnPinning()` accepts persisted v8 keys
- Select-all indeterminate gated as `some && !all` (v9 `getIsSomePageRowsSelected` means “at least one”)
- Public `ColumnDef<TData>` is a one-arg alias over `ColumnDef<DataGridFeatures, TData>`

### Files changed

- `packages/ui/package.json` — `@tanstack/react-table` `^8.21.3` → `^9.1.2`
- `pnpm-lock.yaml` — `@tanstack/react-table@9.1.2`
- `packages/ui/src/components/data-grid/table-features.ts` — new shared features + alias
- `packages/ui/src/components/data-grid/use-data-grid.ts`
- `packages/ui/src/components/data-grid/virtualized-data-grid.tsx`
- `packages/ui/src/components/data-grid/types.ts`
- `packages/ui/src/components/data-grid/data-grid-column-header.tsx`
- `packages/ui/src/components/data-grid/data-grid-toolbar.tsx`
- `packages/ui/src/components/data-grid/data-grid-pagination.tsx`
- `packages/ui/src/components/data-grid/data-grid-faceted-filter.tsx`
- `packages/ui/src/components/data-grid/group-rows.ts`
- `packages/ui/src/components/data-grid/filter-controls.ts`
- `packages/ui/src/components/data-grid/column-resize.ts`
- `packages/ui/src/components/data-grid/index.ts`
- `packages/ui/src/lib/data-table.ts`
- `packages/ui/src/types/data-table.ts`
- `packages/ui/src/hooks/use-data-table.ts`
- `packages/ui/src/components/registries/diceui/data-table/*`
- `packages/ui/src/index.ts` — `ColumnDef` / `RowSelectionState` from the alias
- tests + stories

### Verification

```
pnpm --filter @arcaai/ui test
Test Files  242 passed (242)
Tests       659 passed (659)
```

Re-run 2026-08-16 (same command): **242 passed / 659 passed**. Lockfile has only `@tanstack/react-table@9.1.2` and `@tanstack/table-core@9.1.2` (no v8 copies). No `useReactTable` / `useLegacyTable` remain.

Consumers keep the one-arg `ColumnDef<TData>` alias (`packages/ui/src/index.ts`). `AdminDataGrid<TData extends RowData>` and admin-console screens import that alias; pinning UI uses v9 `start`/`end` (`column.pin('start'|'end')`). Persisted v8 `{ left, right }` is still accepted via `normalizeColumnPinning()`.

React override stays `19.2.8` (`pnpm-workspace.yaml`). No TypeScript / pdfjs / Vite / BullMQ / ioredis / openid-client bumps. No `uv.lock` or Temporal compose edits.

---

## Change History

| Date | Change |
|---|---|
| 2026-08-15 | Ticket created. v8 behavior-lock tests queued before the v9 rewrite. |
| 2026-08-15 | Landed `@tanstack/react-table` 9.1.2 via `useTable` + `dataGridFeatures`. UI tests 242/242, 659/659. Status → Review. |
| 2026-08-15 | Follow-up: `BooleanControl` / `DateControl` still used v8 `Column<TData, TValue>`, so `TData` was treated as `TFeatures`. Switched both to `Column<DataGridFeatures, TData, TValue>`. `@arcaai/ui typecheck` 0 errors. |
| 2026-08-15 | Follow-up: v9 `RowData` is `Record<string, any> \| any[]`. Exported `RowData` from `@arcaai/ui` and constrained `AdminDataGrid<TData extends RowData>`. |
| 2026-08-16 | Completion review against current tree: v9.1.2 + `useTable`/`dataGridFeatures` (not `useLegacyTable`); behavior-lock + bounded-DOM tests present; consumers on one-arg `ColumnDef`; `pnpm --filter @arcaai/ui test` 242/242, 659/659. Status → Completed. |
