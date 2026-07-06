'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type OnChangeFn,
  type PaginationState,
  type RowSelectionState,
  type SortingState,
  type Table,
  type Updater,
} from '@tanstack/react-table';
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { arrayMove } from '@dnd-kit/sortable';

import { DENSITY_ROW_HEIGHT, type Density } from '@/lib/shared/surface';
import { DEFAULT_QUERY_STATE, type DataQueryState, type FilterRule, type PageRequest } from '@/lib/shared';
import { getDefaultFilterOperator } from '@/lib/data-table';
import type { FilterVariant } from '@/types/data-table';

import { buildQueryAnnouncement } from './announce';
import { useCoarsePointer } from './use-container-breakpoint';
import { useGridLayout } from './use-grid-layout';
import { DEFAULT_GRID_FEATURES, DEFAULT_PAGE_SIZE_OPTIONS, type GridLayoutState, type VirtualizedDataGridProps } from './types';

function resolveUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater;
}

export interface UseDataGridResult<TData> {
  table: Table<TData>;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  queryState: DataQueryState;
  setQueryState: (next: DataQueryState) => void;
  setGlobalSearch: (value: string) => void;
  setFilter: (rule: FilterRule | null, id: string) => void;
  density: Density;
  setDensity: (density: Density) => void;
  layout: GridLayoutState;
  isLayoutReady: boolean;
  moveColumn: (activeId: string, overId: string) => void;
  /** Neighbour-swap reorder for the header-menu "Move left/right" (Δ4, WCAG 2.5.7). */
  moveColumnDirection: (id: string, direction: 'left' | 'right') => void;
  /** Reset order/size/visibility/pinning/density to coded defaults + clear the persisted record (Δ8). */
  resetLayout: () => void;
  /** Current visible-column page-size options (default `[25, 50, 100]`). */
  pageSizeOptions: number[];
  /** Debounced polite live-region text for the latest sort/filter/page/density/reset (Δ9). */
  announcement: string;
  features: Required<typeof DEFAULT_GRID_FEATURES>;
}

const GLOBAL_SEARCH_DEBOUNCE_MS = 300;

export function useDataGrid<TData>(props: VirtualizedDataGridProps<TData>): UseDataGridResult<TData> {
  const {
    data,
    columns,
    getRowId,
    manual,
    rowCount,
    pageMode = 'offset',
    queryState: controlledQueryState,
    defaultQueryState,
    onQueryStateChange,
    selection,
    pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
    onPaginate,
    onColumnChange,
    persistence,
    estimateRowHeight,
    density: densityProp,
  } = props;

  const features = { ...DEFAULT_GRID_FEATURES, ...props.features };

  // ----- Query state (controlled or uncontrolled) -----
  const defaultLimit = pageSizeOptions[0] ?? 25;
  const [internalQueryState, setInternalQueryState] = useState<DataQueryState>(() => ({
    ...DEFAULT_QUERY_STATE,
    ...defaultQueryState,
    pagination:
      defaultQueryState?.pagination ??
      (pageMode === 'cursor' ? { mode: 'cursor', cursor: null, limit: defaultLimit } : { mode: 'offset', page: 0, limit: defaultLimit }),
  }));
  const isControlled = controlledQueryState !== undefined;
  const queryState = controlledQueryState ?? internalQueryState;

  const commitQueryState = useCallback(
    (next: DataQueryState) => {
      onQueryStateChange?.(next);
      if (!isControlled) setInternalQueryState(next);
    },
    [isControlled, onQueryStateChange],
  );

  // ----- Layout (D8 persistence) -----
  const defaultLayout = useMemo<GridLayoutState>(
    () => ({ order: [], sizing: {}, visibility: {}, pinning: {}, density: densityProp ?? 'comfortable' }),
    [densityProp],
  );
  const { layout, isLayoutReady, setLayout } = useGridLayout({ persistence, defaultLayout });
  // Coarse pointers (touch) force comfortable density — compact 36px is below the
  // 44px hit-area floor (Δ9). The persisted preference is preserved untouched.
  const coarsePointer = useCoarsePointer();
  const density: Density = coarsePointer ? 'comfortable' : (densityProp ?? layout.density);

  const [announcement, setAnnouncement] = useState('');

  const emitLayout = useCallback(
    (next: GridLayoutState) => {
      setLayout(next);
      onColumnChange?.(next);
    },
    [setLayout, onColumnChange],
  );

  // ----- Row selection (controlled or uncontrolled) -----
  const [internalSelection, setInternalSelection] = useState<RowSelectionState>({});
  const rowSelection = selection?.value ?? internalSelection;

  // ----- Derived TanStack state from query state -----
  const sorting: SortingState = queryState.sorting as SortingState;
  const columnFilters: ColumnFiltersState = useMemo(() => queryState.filters.map((f) => ({ id: f.id, value: f.value })), [queryState.filters]);
  const globalFilter = queryState.globalSearch ?? '';
  const pagination: PaginationState = useMemo(
    () => ({
      pageIndex: queryState.pagination.mode === 'offset' ? queryState.pagination.page : 0,
      pageSize: queryState.pagination.limit,
    }),
    [queryState.pagination],
  );

  // ----- Change handlers -----
  const onSortingChange: OnChangeFn<SortingState> = useCallback(
    (updater) => {
      const next = resolveUpdater(updater, sorting);
      commitQueryState({ ...queryState, sorting: next });
    },
    [sorting, queryState, commitQueryState],
  );

  const onColumnFiltersChange: OnChangeFn<ColumnFiltersState> = useCallback(
    (updater) => {
      const next = resolveUpdater(updater, columnFilters);
      const filters: FilterRule[] = next.map((cf) => {
        const existing = queryState.filters.find((f) => f.id === cf.id);
        const variant = (existing?.variant ?? 'text') as FilterVariant;
        return {
          id: cf.id,
          value: cf.value,
          operator: existing?.operator ?? getDefaultFilterOperator(variant),
          variant,
        };
      });
      commitQueryState({ ...queryState, filters });
    },
    [columnFilters, queryState, commitQueryState],
  );

  const onGlobalFilterChange: OnChangeFn<string> = useCallback(
    (updater) => {
      const next = resolveUpdater(updater, globalFilter);
      commitQueryState({ ...queryState, globalSearch: next });
    },
    [globalFilter, queryState, commitQueryState],
  );

  const onPaginationChange: OnChangeFn<PaginationState> = useCallback(
    (updater) => {
      const next = resolveUpdater(updater, pagination);
      const req: PageRequest =
        queryState.pagination.mode === 'cursor'
          ? { mode: 'cursor', cursor: queryState.pagination.cursor, limit: next.pageSize }
          : { mode: 'offset', page: next.pageIndex, limit: next.pageSize };
      commitQueryState({ ...queryState, pagination: req });
      onPaginate?.(req);
    },
    [pagination, queryState, commitQueryState, onPaginate],
  );

  const onRowSelectionChange: OnChangeFn<RowSelectionState> = useCallback(
    (updater) => {
      const next = resolveUpdater(updater, rowSelection);
      selection?.onChange?.(next);
      if (selection?.value === undefined) setInternalSelection(next);
    },
    [rowSelection, selection],
  );

  // Layout sub-state change handlers (visibility/order/pinning/sizing).
  const onColumnVisibilityChange: OnChangeFn<GridLayoutState['visibility']> = useCallback(
    (updater) => {
      const next = resolveUpdater(updater, layout.visibility);
      // Force ≥ 1 visible *hideable* column (cannot hide the last content column).
      const hideableIds = columns
        .filter((c) => (c as { enableHiding?: boolean }).enableHiding !== false)
        .map((c) => (c as { id?: string }).id ?? (c as { accessorKey?: string }).accessorKey)
        .filter((id): id is string => Boolean(id));
      const visibleHideable = hideableIds.filter((id) => next[id] !== false);
      if (hideableIds.length > 0 && visibleHideable.length === 0) return;
      emitLayout({ ...layout, visibility: next });
    },
    [layout, columns, emitLayout],
  );

  const onColumnOrderChange: OnChangeFn<GridLayoutState['order']> = useCallback(
    (updater) => emitLayout({ ...layout, order: resolveUpdater(updater, layout.order) }),
    [layout, emitLayout],
  );
  const onColumnPinningChange: OnChangeFn<GridLayoutState['pinning']> = useCallback(
    (updater) => emitLayout({ ...layout, pinning: resolveUpdater(updater, layout.pinning) }),
    [layout, emitLayout],
  );
  const onColumnSizingChange: OnChangeFn<GridLayoutState['sizing']> = useCallback(
    (updater) => emitLayout({ ...layout, sizing: resolveUpdater(updater, layout.sizing) }),
    [layout, emitLayout],
  );

  const table = useReactTable<TData>({
    data,
    columns,
    state: {
      sorting,
      columnFilters,
      globalFilter,
      pagination,
      rowSelection,
      columnVisibility: layout.visibility,
      columnOrder: layout.order,
      columnPinning: layout.pinning,
      columnSizing: layout.sizing,
    },
    getRowId: getRowId ? (row, index) => getRowId(row, index) : undefined,
    manualSorting: manual?.sorting ?? false,
    manualFiltering: manual?.filtering ?? false,
    manualPagination: manual?.pagination ?? false,
    rowCount: manual?.pagination ? rowCount : undefined,
    enableRowSelection: features.rowSelection,
    enableSorting: features.sorting,
    enableHiding: features.columnVisibility,
    enableColumnResizing: features.columnResize,
    columnResizeMode: 'onChange',
    onSortingChange,
    onColumnFiltersChange,
    onGlobalFilterChange,
    onPaginationChange,
    onRowSelectionChange,
    onColumnVisibilityChange,
    onColumnOrderChange,
    onColumnPinningChange,
    onColumnSizingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  // ----- Virtualization -----
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight ?? DENSITY_ROW_HEIGHT[density],
    overscan: 8,
  });

  // ----- Public helpers -----
  const globalSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setGlobalSearch = useCallback(
    (value: string) => {
      if (globalSearchTimer.current) clearTimeout(globalSearchTimer.current);
      globalSearchTimer.current = setTimeout(() => {
        commitQueryState({ ...queryState, globalSearch: value });
      }, GLOBAL_SEARCH_DEBOUNCE_MS);
    },
    [queryState, commitQueryState],
  );

  const setFilter = useCallback(
    (rule: FilterRule | null, id: string) => {
      const others = queryState.filters.filter((f) => f.id !== id);
      const filters = rule ? [...others, rule] : others;
      commitQueryState({ ...queryState, filters });
    },
    [queryState, commitQueryState],
  );

  const setDensity = useCallback(
    (next: Density) => {
      emitLayout({ ...layout, density: next });
      setAnnouncement(`${next === 'compact' ? 'Compact' : 'Comfortable'} density.`);
    },
    [layout, emitLayout],
  );

  const moveColumn = useCallback(
    (activeId: string, overId: string) => {
      if (activeId === overId) return;
      const current = layout.order.length ? layout.order : table.getAllLeafColumns().map((c) => c.id);
      const from = current.indexOf(activeId);
      const to = current.indexOf(overId);
      if (from < 0 || to < 0) return;
      emitLayout({ ...layout, order: arrayMove(current, from, to) });
    },
    [layout, table, emitLayout],
  );

  const moveColumnDirection = useCallback(
    (id: string, direction: 'left' | 'right') => {
      const current = layout.order.length ? layout.order : table.getAllLeafColumns().map((c) => c.id);
      const from = current.indexOf(id);
      const to = direction === 'left' ? from - 1 : from + 1;
      if (from < 0 || to < 0 || to >= current.length) return;
      emitLayout({ ...layout, order: arrayMove(current, from, to) });
    },
    [layout, table, emitLayout],
  );

  const resetLayout = useCallback(() => {
    // Writes coded defaults AND overwrites the persisted record (clears personalization).
    emitLayout(defaultLayout);
    setAnnouncement('Layout reset to default.');
  }, [defaultLayout, emitLayout]);

  // ----- Live-region announcements (Δ9): sort / filter / page changes. -----
  const announceSkip = useRef(true);
  const labelFor = useCallback(
    (id: string) => {
      const col = columns.find((c) => ((c as { id?: string }).id ?? (c as { accessorKey?: string }).accessorKey) === id);
      return col?.meta?.label ?? id;
    },
    [columns],
  );
  useEffect(() => {
    if (announceSkip.current) {
      announceSkip.current = false;
      return;
    }
    setAnnouncement(
      buildQueryAnnouncement({
        sorting: queryState.sorting,
        filters: queryState.filters,
        globalSearch: queryState.globalSearch,
        pagination: queryState.pagination,
        total: table.getRowCount(),
        pageCount: table.getPageCount(),
        labelFor,
      }),
    );
  }, [queryState.sorting, queryState.filters, queryState.globalSearch, queryState.pagination, labelFor]);

  return {
    table,
    rowVirtualizer,
    scrollRef,
    queryState,
    setQueryState: commitQueryState,
    setGlobalSearch,
    setFilter,
    density,
    setDensity,
    layout,
    isLayoutReady,
    moveColumn,
    moveColumnDirection,
    resetLayout,
    pageSizeOptions,
    announcement,
    features,
  };
}
