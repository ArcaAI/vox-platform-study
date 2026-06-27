/**
 * Cross-component query-state contract (TASK-372 §3.1.4).
 *
 * `DataQueryState` is the shared sort/filter/search/pagination model the grid
 * (and timeline) speak. `toPaginatedQuery` serializes it to the backend
 * `PaginatedQuery` CSV contract (`filters` = `field:value`, `sort` =
 * `field:asc|desc`).
 */

import type { FilterOperator, FilterVariant } from '../../types/data-table';
import type { PageRequest } from './pagination';

export interface SortRule {
  id: string;
  desc: boolean;
}

export interface FilterRule<T = unknown> {
  id: string;
  operator: FilterOperator;
  value: T;
  variant: FilterVariant;
}

export interface DataQueryState {
  pagination: PageRequest;
  sorting: SortRule[];
  filters: FilterRule[];
  globalSearch?: string;
}

export const DEFAULT_QUERY_STATE: DataQueryState = {
  pagination: { mode: 'offset', page: 0, limit: 20 },
  sorting: [],
  filters: [],
};

function hasValue(value: unknown): boolean {
  if (value === '' || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Serialize `DataQueryState` → backend `PaginatedQuery` query params. The
 * backend `filters` contract is a simple `field:value` CSV (the operator is
 * applied server-side / used only for the client UI), so the operator is not
 * encoded here. Multi-value filters are joined with `|`.
 */
export function toPaginatedQuery(s: DataQueryState): Record<string, string> {
  const out: Record<string, string> = {};

  if (s.pagination.mode === 'offset') {
    out.page = String(s.pagination.page);
    out.limit = String(s.pagination.limit);
  } else {
    if (s.pagination.cursor) out.cursor = s.pagination.cursor;
    out.limit = String(s.pagination.limit);
  }

  if (s.globalSearch) out.search = s.globalSearch;

  if (s.sorting.length > 0) {
    out.sort = s.sorting.map((r) => `${r.id}:${r.desc ? 'desc' : 'asc'}`).join(',');
  }

  const filterCsv = s.filters
    .filter((f) => hasValue(f.value))
    .map((f) => `${f.id}:${Array.isArray(f.value) ? f.value.join('|') : String(f.value)}`)
    .join(',');
  if (filterCsv) out.filters = filterCsv;

  return out;
}
