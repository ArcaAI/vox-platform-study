/**
 * @arcaai/vox - URL Utilities (TASK-039, hardened TASK-215)
 *
 * Shared helpers for building query strings from pagination params and filters.
 * Safe to compose: appendPagination(appendFilters(url, f), p) produces one `?`.
 */

import type { PaginationParams } from '../types/common';
import { DEFAULT_PAGE_SIZE } from '../types/common';

function joinQs(url: string, qs: string): string {
  if (!qs) return url;
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

/**
 * Appends pagination query parameters to a URL.
 * When no limit is provided, {@link DEFAULT_PAGE_SIZE} (10) is used.
 */
export function appendPagination(url: string, pagination?: PaginationParams): string {
  if (!pagination) return url;
  const params = new URLSearchParams();
  if (pagination.page !== undefined) params.set('page', String(pagination.page));
  params.set('limit', String(pagination.limit ?? DEFAULT_PAGE_SIZE));
  return joinQs(url, params.toString());
}

/**
 * Appends arbitrary filter parameters to a URL.
 * Skips undefined values and joins arrays with commas.
 */
export function appendFilters(url: string, filters: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    params.set(key, Array.isArray(value) ? value.join(',') : value);
  }
  return joinQs(url, params.toString());
}
