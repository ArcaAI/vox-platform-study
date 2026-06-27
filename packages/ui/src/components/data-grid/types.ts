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
   * cursor contract, D7 / TASK-373). Drives the cursor pager's next/disabled.
   */
  cursor?: { hasMore?: boolean; nextCursor?: string | null };

  // Controlled / uncontrolled query state.
  queryState?: DataQueryState;
  defaultQueryState?: Partial<DataQueryState>;
  onQueryStateChange?: (next: DataQueryState) => void;

  features?: GridFeatureFlags;

  selection?: { value?: RowSelectionState; onChange?: (s: RowSelectionState) => void };

  pageSizeOptions?: number[];
  onPaginate?: (req: PageRequest) => void;

  onRowClick?: (row: TData) => void;
  onColumnChange?: (state: GridLayoutState) => void;

  persistence?: GridPersistenceConfig;

  toolbar?: React.ReactNode;
  actionBar?: React.ReactNode;
  estimateRowHeight?: number;

  /** Fixed viewport height for the virtualized scroll container. Default 480. */
  height?: number | string;

  /** Retry handler for the error state. */
  onRetry?: () => void;

  'aria-label'?: string;
}

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
