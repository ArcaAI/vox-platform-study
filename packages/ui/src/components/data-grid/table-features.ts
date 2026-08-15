import {
  columnFacetingFeature,
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createFacetedMinMaxValues,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFns,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
  type ColumnDef as TanstackColumnDef,
  type ColumnPinningState,
  type RowData,
  type RowSelectionState,
} from '@tanstack/react-table';

/**
 * Shared v9 feature registry for VirtualizedDataGrid and the diceui DataTable
 * helpers. Consumers keep a one-arg `ColumnDef<TData>` alias.
 */
export const dataGridFeatures = tableFeatures({
  columnFacetingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnResizingFeature,
  columnVisibilityFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  facetedRowModel: createFacetedRowModel(),
  facetedMinMaxValues: createFacetedMinMaxValues(),
  facetedUniqueValues: createFacetedUniqueValues(),
  filterFns,
  sortFns,
});

export type DataGridFeatures = typeof dataGridFeatures;

export type ColumnDef<TData extends RowData, TValue = unknown> = TanstackColumnDef<DataGridFeatures, TData, TValue>;

export type { RowSelectionState, RowData };

/** Accept persisted v8 `{ left, right }` and v9 `{ start, end }`. */
export function normalizeColumnPinning(pinning: ColumnPinningState | { left?: string[]; right?: string[] } | undefined): ColumnPinningState {
  const raw = pinning ?? {};
  const legacy = raw as { left?: string[]; right?: string[] };
  const next = raw as ColumnPinningState;
  return { start: next.start ?? legacy.left ?? [], end: next.end ?? legacy.right ?? [] };
}
