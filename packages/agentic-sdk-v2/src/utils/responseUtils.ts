/**
 * @arcaai/vox - Response Utilities (TASK-215)
 *
 * Handles API responses that may be either raw arrays or paginated wrappers.
 */

import type { PaginatedResponse } from '../types/common';
import { DEFAULT_PAGE_SIZE } from '../types/common';

/**
 * Extracts an array from an API response that may be a raw array
 * or a paginated wrapper. Checks properties in priority order:
 *   1. Raw array
 *   2. `{ data: T[] }` — @arcaai/applications Paginated<T>
 *   3. `{ items: T[] }` — @arcaai/types PaginatedResponse<T>
 *   4. `{ results: T[] }` — common REST convention
 */
export function extractArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw;
  if (raw == null || typeof raw !== 'object') return [];

  const obj = raw as Record<string, unknown>;
  for (const key of ['data', 'items', 'results'] as const) {
    if (key in obj && Array.isArray(obj[key])) return obj[key] as T[];
  }
  return [];
}

/**
 * Extracts a full {@link PaginatedResponse} from an API response.
 *
 * The backend returns `{ data, count, limit, page }`.
 * This normalises it into the SDK's `PaginatedResponse<T>` shape
 * which includes computed `totalPages` and `hasMore`.
 */
export function extractPaginated<T>(raw: unknown): PaginatedResponse<T> {
  const data = extractArray<T>(raw);

  if (raw == null || typeof raw !== 'object') {
    return { data, total: data.length, page: 1, limit: DEFAULT_PAGE_SIZE, totalPages: 1, hasMore: false };
  }

  const obj = raw as Record<string, unknown>;
  const total = typeof obj.count === 'number' ? obj.count : typeof obj.total === 'number' ? obj.total : data.length;
  const limit = typeof obj.limit === 'number' && obj.limit > 0 ? obj.limit : DEFAULT_PAGE_SIZE;
  const page = typeof obj.page === 'number' ? obj.page : 1;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasMore = page < totalPages;

  return { data, total, page, limit, totalPages, hasMore };
}
