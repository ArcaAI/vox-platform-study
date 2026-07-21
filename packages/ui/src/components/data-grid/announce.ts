/**
 * Live-region announcement text. Pure so the polite status
 * copy is unit-testable; the grid drives a visually-hidden
 * `role="status" aria-live="polite"` region with the result.
 */
import type { FilterRule, PageRequest, SortRule } from '@/lib/shared';

import { getItemRange } from './pagination-window';

export interface QueryAnnouncementInput {
  sorting: SortRule[];
  filters: FilterRule[];
  globalSearch?: string;
  pagination: PageRequest;
  total: number;
  pageCount: number;
  labelFor: (id: string) => string;
}

/** Concise combined announcement for sort / filter / page changes. */
export function buildQueryAnnouncement(a: QueryAnnouncementInput): string {
  const parts: string[] = [];

  if (a.sorting.length > 0) {
    const keys = a.sorting.map((s) => `${a.labelFor(s.id)}, ${s.desc ? 'descending' : 'ascending'}`).join('; ');
    parts.push(`Sorted by ${keys}.`);
  }

  const activeFilters = a.filters.length + (a.globalSearch && a.globalSearch.trim() !== '' ? 1 : 0);
  if (activeFilters > 0) {
    parts.push(`${activeFilters} filter${activeFilters === 1 ? '' : 's'} active, ${a.total} result${a.total === 1 ? '' : 's'}.`);
  }

  if (a.pagination.mode === 'offset') {
    const { first, last, total } = getItemRange({ page: a.pagination.page, limit: a.pagination.limit, total: a.total });
    const showing = total > 0 ? `, showing ${first}\u2013${last} of ${total}` : '';
    parts.push(`Page ${a.pagination.page + 1} of ${Math.max(1, a.pageCount)}${showing}.`);
  }

  return parts.join(' ');
}
