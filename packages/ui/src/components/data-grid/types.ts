import type { ColumnDef, ColumnOrderState, ColumnPinningState, ColumnSizingState, RowSelectionState, VisibilityState } from '@tanstack/react-table';
import type * as React from 'react';

import type { AsyncStateProps, BaseSurfaceProps, Density } from '@/lib/shared/surface';
import type { DataQueryState, PageRequest } from '@/lib/shared';

/** Per-user persisted grid layout (D8). */
export interface GridLayoutState {
  order: ColumnOrderState;
  sizing: ColumnSizingState;
  visibility: VisibilityState;
  pinning: ColumnPinningState;
  density: Density;
}

/**
 * Transport-agnostic persistence port (D5/D8). The default app-side adapter
 * wraps `useUserSettings`; tests/SSR inject a fake. `@arcaai/ui` itself stays
 * fetch-free.
 */
export interface GridLayoutPersistenceAdapter {
  load: (namespace: string, key: string) => Promise<GridLayoutState | null>;
  save: (namespace: string, key: string, state: GridLayoutState) => Promise<void>;
}

export interface GridPersistenceConfig {
  /** Grid instance id, e.g. 'tenants' | 'users' | 'audit-log'. */
  key: string;
  /** Default 'ui.data-grid'. */
  namespace?: string;
  /** Default true; false → in-memory only. */
  enabled?: boolean;
  /** Default: useUserSettings-backed (app layer). Injectable for tests/SSR. */
  adapter?: GridLayoutPersistenceAdapter;
  /** Debounce window for save coalescing (ms). Default 600. */
  debounceMs?: number;
}

/**
 * Grouped-row display config. Group headers are injected between
 * CONTIGUOUS runs of the accessor value in page order (the grid never
 * re-sorts); on server-driven grids, sort by the group field first so groups
 * are contiguous per page.
 */
export interface GroupByConfig<TData> {
  /** Row → group key. `null`/`undefined`/blank fall under `fallbackLabel`. */
  accessor: (row: TData) => string | null | undefined;
  /** Custom header content. Default: `label (count)` + sr-only group summary. */
  renderHeader?: (label: string, count: number) => React.ReactNode;
  /** Group label for rows without a value. Default `'—'`. */
  fallbackLabel?: string;
}

export interface GridFeatureFlags {
  globalSearch?: boolean;
  columnSearch?: boolean;
  facetedFilters?: boolean;
  columnReorder?: boolean;
  columnResize?: boolean;
  columnVisibility?: boolean;
  columnPinning?: boolean;
  rowSelection?: boolean;
  sorting?: boolean;
  columnVirtualization?: boolean;
}

export interface VirtualizedDataGridProps<TData> extends BaseSurfaceProps, AsyncStateProps {
  data: TData[];
  columns: ColumnDef<TData>[];
  getRowId?: (row: TData, index: number) => string;

  /** When true, the server owns sort/filter/pagination. */
  manual?: { sorting?: boolean; filtering?: boolean; pagination?: boolean };
  /** Required when `manual.pagination` (offset total). */
  rowCount?: number;
  pageMode?: 'offset' | 'cursor';
  /**
   * Cursor-mode page info supplied by the consumer (INERT today — no server
   * cursor contract, D7). Drives the cursor pager's next/disabled.
   */
  cursor?: { hasMore?: boolean; nextCursor?: string | null };

  // Controlled / uncontrolled query state.
  queryState?: DataQueryState;
  defaultQueryState?: Partial<DataQueryState>;
  onQueryStateChange?: (next: DataQueryState) => void;

  features?: GridFeatureFlags;

  /**
   * Render namespace-style group-header rows (label + count)
   * between contiguous groups of the current page. Purely presentational:
   * omitting it changes nothing.
   */
  groupBy?: GroupByConfig<TData>;

  selection?: { value?: RowSelectionState; onChange?: (s: RowSelectionState) => void };

  pageSizeOptions?: number[];
  onPaginate?: (req: PageRequest) => void;

  onRowClick?: (row: TData) => void;
  onColumnChange?: (state: GridLayoutState) => void;

  persistence?: GridPersistenceConfig;

  /** Custom toolbar. Omit to render the default responsive `DataGridToolbar`. */
  toolbar?: React.ReactNode;
  /** Selection action bar; shown only when ≥1 row is selected. */
  actionBar?: React.ReactNode;
  estimateRowHeight?: number;

  /**
   * Scroll-container height. When **unset (default)** the grid runs in
   * fill-height mode (Δ1): the root is `flex min-h-0 flex-1 flex-col` and the
   * scroll container is `h-full`, so it fills a flex parent under a sticky
   * header. Pass a number/string for embedded/fixed grids (detail tabs, cards).
   */
  height?: number | string;

  /** Refetch is in flight — pager stays mounted, navigators disable + `aria-busy` (Δ7, zero CLS). */
  isBusy?: boolean;

  /** Retry handler for the error state. */
  onRetry?: () => void;

  'aria-label'?: string;
}

/** Standardized admin page-size options (Δ7): `[25, 50, 100]`, default 25. */
export const DEFAULT_PAGE_SIZE_OPTIONS: number[] = [25, 50, 100];

export const DEFAULT_GRID_FEATURES: Required<GridFeatureFlags> = {
  globalSearch: true,
  columnSearch: false,
  facetedFilters: true,
  columnReorder: true,
  columnResize: true,
  columnVisibility: true,
  columnPinning: true,
  rowSelection: true,
  sorting: true,
  columnVirtualization: false,
};
