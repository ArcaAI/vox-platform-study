/**
 * Grouped-row support for `VirtualizedDataGrid`.
 *
 * Pure display-layer grouping: the table's row model is untouched (sorting,
 * selection, filtering, pagination all keep operating on data rows); grouping
 * only interleaves non-interactive header entries between CONTIGUOUS runs of
 * the group key, in page order. On server-driven grids the server therefore
 * decides the grouping by sorting on the group field first — the grid never
 * re-orders rows to force groups together.
 */

import type { Row, RowData } from '@tanstack/react-table';
import type { DataGridFeatures } from './table-features';
import type { GroupByConfig } from './types';

/** One virtualized display entry: a group header or a data row. */
export type DisplayRow<TData extends RowData> = { kind: 'group'; label: string; count: number } | { kind: 'data'; row: Row<DataGridFeatures, TData> };

/** Label used for rows whose group accessor yields null/undefined/blank. */
export const DEFAULT_GROUP_FALLBACK_LABEL = '—';

/**
 * Interleave group-header entries (label + contiguous-run count) with the data
 * rows. Without `groupBy` this is an index-stable pass-through, so the render
 * path can always map over the result.
 */
export function buildDisplayRows<TData extends RowData>(rows: Row<DataGridFeatures, TData>[], groupBy?: GroupByConfig<TData>): DisplayRow<TData>[] {
  if (!groupBy) return rows.map((row) => ({ kind: 'data', row }));

  const fallback = groupBy.fallbackLabel ?? DEFAULT_GROUP_FALLBACK_LABEL;
  const out: DisplayRow<TData>[] = [];
  let currentLabel: string | null = null;
  let currentHeader: Extract<DisplayRow<TData>, { kind: 'group' }> | null = null;

  for (const row of rows) {
    const raw = groupBy.accessor(row.original);
    const label = raw == null || String(raw).trim() === '' ? fallback : String(raw);
    if (currentHeader === null || label !== currentLabel) {
      currentLabel = label;
      currentHeader = { kind: 'group', label, count: 0 };
      out.push(currentHeader);
    }
    currentHeader.count += 1;
    out.push({ kind: 'data', row });
  }
  return out;
}
