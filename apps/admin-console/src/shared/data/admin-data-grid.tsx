'use client';

/**
 * AdminDataGrid — the console's thin wrapper over the @arcaai/ui
 * `VirtualizedDataGrid`. It applies the console defaults and
 * bridges the three Phase-4 adapters that already live in `shared/data`:
 *   • layout persistence → `createGridLayoutPersistenceAdapter` (`ui.data-grid`)
 *   • URL query-state → `useAdminGridParams` (the `grid-url-state` nuqs codec)
 *   • list envelopes → `normalizeList` (called in the screen; rows/total in)
 *
 * The grid is SERVER-DRIVEN: manual sorting/filtering/pagination is on, so the
 * screen keeps owning data fetching (TanStack Query) and passes
 * rows + total + isLoading + error + onRetry. The wrapper is a controlled
 * component over `queryState`/`onQueryStateChange` (from `useAdminGridParams`),
 * which is the single URL binding — no duplicate nuqs state.
 */

import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';
import { useQueryStates } from 'nuqs';
import {
  VirtualizedDataGrid,
  type ColumnDef,
  type DataQueryState,
  type GroupByConfig,
  type RowData,
  type RowSelectionState,
  type SortRule,
} from '@arcaai/ui';
import type { ListParams } from '@/shared/api';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';
import { UI_DATA_GRID_NAMESPACE, sharedGridLayoutPersistence } from './grid-persistence';
import { DEFAULT_LIMIT, encodeFilters, gridQueryParsers, serializeSort, toListParams } from './grid-url-state';

/** Stable empty default so `useAdminGridParams` memo deps don't churn. */
const NO_SORT: SortRule[] = [];

export interface UseAdminGridParamsOptions {
  /** Fields the omni search targets → gateway `searchFields` CSV. Pass a stable ref. */
  searchFields?: string[];
  /** Effective sort applied when the URL carries none. Pass a stable ref. */
  defaultSort?: SortRule[];
}

export interface AdminGridQuery {
  /** Controlled state to hand to `<AdminDataGrid queryState=… />`. */
  queryState: DataQueryState;
  /** `onQueryStateChange` for the grid; also drives screen CTAs (e.g. clear filters). */
  setQueryState: (next: DataQueryState) => void;
  /** Serialized gateway params for the screen's TanStack Query list hook. */
  listParams: ListParams;
}

/**
 * Binds the grid's shareable query-state (search / sort / page / limit / typed
 * filters) to the URL through the `grid-url-state` nuqs codec, and derives the
 * `ListParams` the screen's list hook sends to the BFF. A result-set change
 * (sort / filter / search) resets to page 0 — parity with the legacy screens so
 * a narrowed result set never strands the user on an out-of-range page.
 */
export function useAdminGridParams(options?: UseAdminGridParamsOptions): AdminGridQuery {
  const searchFields = options?.searchFields;
  const defaultSort = options?.defaultSort ?? NO_SORT;

  const [{ search, page, limit, sort, f }, setUrlState] = useQueryStates(gridQueryParsers);

  const queryState = useMemo<DataQueryState>(
    () => ({
      pagination: { mode: 'offset', page, limit },
      sorting: sort.length > 0 ? sort : defaultSort,
      filters: f,
      globalSearch: search.length > 0 ? search : undefined,
    }),
    [search, page, limit, sort, f, defaultSort],
  );

  // `setQueryState` runs only from grid event handlers (post-commit), so closing
  // over the current `queryState` always sees the latest — no ref needed.
  const setQueryState = useCallback(
    (next: DataQueryState) => {
      const changedResultSet =
        serializeSort(next.sorting) !== serializeSort(queryState.sorting) ||
        encodeFilters(next.filters) !== encodeFilters(queryState.filters) ||
        (next.globalSearch ?? '') !== (queryState.globalSearch ?? '');

      const nextPage = next.pagination.mode === 'offset' ? next.pagination.page : 0;
      const finalPage = changedResultSet ? 0 : nextPage;
      // The default sort is implicit — only write `sort=` when it deviates, so a
      // reset (or an untouched grid) keeps the URL clean.
      const isDefaultSort = serializeSort(next.sorting) === serializeSort(defaultSort);

      // `null` resets a param to its default (dropped from the URL) — keeps links clean.
      setUrlState({
        search: next.globalSearch && next.globalSearch.length > 0 ? next.globalSearch : null,
        sort: !isDefaultSort && next.sorting.length > 0 ? next.sorting : null,
        f: next.filters.length > 0 ? next.filters : null,
        page: finalPage > 0 ? finalPage : null,
        limit: next.pagination.limit !== DEFAULT_LIMIT ? next.pagination.limit : null,
      });
    },
    [setUrlState, defaultSort, queryState],
  );

  const listParams = useMemo(() => toListParams(queryState, { searchFields }), [queryState, searchFields]);

  return { queryState, setQueryState, listParams };
}

export interface AdminDataGridProps<TData extends RowData> {
  /** Persistence key under the `ui.data-grid` namespace, e.g. 'tenants' | 'users'. */
  gridId: string;
  /** Column defs with `meta` (`label`, `variant`, `options`) for typed filters. */
  columns: ColumnDef<TData>[];
  rows: TData[];
  /** Server total for the offset pager (ignored in cursor mode). */
  total: number;

  /** Controlled query-state + setter, from `useAdminGridParams`. */
  queryState: DataQueryState;
  onQueryStateChange: (next: DataQueryState) => void;

  isLoading?: boolean;
  /** Refetch in flight → pager disables + `aria-busy`, zero CLS. */
  isBusy?: boolean;
  error?: Error | null;
  onRetry?: () => void;

  /** Shown when the list is empty with NO active search/filters. */
  emptyState?: ReactNode;
  /** Shown when the list is empty BECAUSE of active search/filters. */
  emptyFilteredState?: ReactNode;

  pageMode?: 'offset' | 'cursor';
  cursor?: { hasMore?: boolean; nextCursor?: string | null };

  /** Grouped-row display (e.g. namespace sections). Pair with a group-field-first sort so groups are contiguous per page. */
  groupBy?: GroupByConfig<TData>;

  selection?: { value?: RowSelectionState; onChange?: (selection: RowSelectionState) => void };
  /** Selection action bar; the grid shows it only when ≥1 row is selected. */
  actionBar?: ReactNode;
  onRowClick?: (row: TData) => void;
  /** Row identity. Defaults to `row.id` (every console resource carries one). */
  getRowId?: (row: TData) => string;

  'aria-label': string;
  /** Escape hatch to skip server-persisted layout (default: enabled). */
  persistenceEnabled?: boolean;
}

export function AdminDataGrid<TData extends RowData>({
  gridId,
  columns,
  rows,
  total,
  queryState,
  onQueryStateChange,
  isLoading,
  isBusy,
  error,
  onRetry,
  emptyState,
  emptyFilteredState,
  pageMode = 'offset',
  cursor,
  groupBy,
  selection,
  actionBar,
  onRowClick,
  getRowId,
  'aria-label': ariaLabel,
  persistenceEnabled = true,
}: AdminDataGridProps<TData>) {
  const hasRows = rows.length > 0;
  // Block error (no data) → the grid's error slot; stale error (rows present) →
  // an inline banner above the table so the last-loaded rows stay visible
  // (the list-frame error variant, design-spec
  const blockError = hasRows ? null : (error ?? null);
  const staleError = hasRows ? (error ?? null) : null;

  const hasActiveQuery = (queryState.globalSearch?.trim().length ?? 0) > 0 || queryState.filters.length > 0;
  const emptySlot = hasActiveQuery ? emptyFilteredState : emptyState;

  const resolveRowId = useCallback((row: TData) => (getRowId ? getRowId(row) : (row as { id: string }).id), [getRowId]);

  return (
    <>
      {staleError ? <ErrorBanner error={staleError} onRetry={onRetry} /> : null}
      <VirtualizedDataGrid<TData>
        aria-label={ariaLabel}
        columns={columns}
        data={rows}
        getRowId={resolveRowId}
        manual={{ sorting: true, filtering: true, pagination: true }}
        rowCount={total}
        pageMode={pageMode}
        cursor={cursor}
        groupBy={groupBy}
        queryState={queryState}
        onQueryStateChange={onQueryStateChange}
        features={{ rowSelection: Boolean(selection) }}
        selection={selection}
        actionBar={actionBar}
        onRowClick={onRowClick}
        isLoading={isLoading}
        isBusy={isBusy}
        error={blockError}
        errorState={(err) => <ErrorState error={err} onRetry={onRetry} />}
        emptyState={emptySlot}
        onRetry={onRetry}
        persistence={
          persistenceEnabled ? { key: gridId, namespace: UI_DATA_GRID_NAMESPACE, adapter: sharedGridLayoutPersistence, enabled: true } : undefined
        }
      />
    </>
  );
}
