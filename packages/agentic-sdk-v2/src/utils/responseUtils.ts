/**
 * @arcaai/vox - Response Utilities
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

/**
 * Client page result for CURSOR (keyset) pagination — the cursor sibling of the
 * offset {@link extractPaginated}. Structurally mirrors the `@arcaai/ui`
 * `PageResult<T>` contract (`packages/ui/src/lib/shared/pagination.ts`) so the
 * admin grid/timeline can consume it directly, WITHOUT `@arcaai/vox` taking a
 * dependency on `@arcaai/ui` (the two packages stay decoupled; the consuming app
 * wires them together). Cursor mode is count-free, so `total`/`page`/`totalPages`
 * are intentionally omitted (they remain `undefined` on the `PageResult` shape).
 */
export interface CursorPageResult<T> {
  /** Mapped from the server `data` array (the `PageResult.rows` field). */
  rows: T[];
  /** Items per page echoed by the server. */
  limit?: number;
  /** Whether another page exists after this one. */
  hasMore?: boolean;
  /** Opaque keyset token for the next page; `null` on the last page. */
  nextCursor?: string | null;
}

/**
 * Normalizes a server `CursorPaginatedResponse<T>` (`{ data, nextCursor,
 * hasMore, limit }` — reference endpoint `GET /admin/audit-logs/cursor`)
 * into the client {@link CursorPageResult} (`PageResult<T>`-shaped) cursor page.
 *
 * The offset counterpart is {@link extractPaginated}. Defensive like its
 * siblings: tolerates raw arrays / `items` / `results` wrappers for `rows`,
 * derives `hasMore` from `nextCursor` when the flag is absent, and falls back to
 * {@link DEFAULT_PAGE_SIZE} for a missing/invalid `limit`.
 */
export function extractCursorPaginated<T>(raw: unknown): CursorPageResult<T> {
  const rows = extractArray<T>(raw);

  if (raw == null || typeof raw !== 'object') {
    return { rows, limit: DEFAULT_PAGE_SIZE, hasMore: false, nextCursor: null };
  }

  const obj = raw as Record<string, unknown>;
  const limit = typeof obj.limit === 'number' && obj.limit > 0 ? obj.limit : DEFAULT_PAGE_SIZE;
  const nextCursor = typeof obj.nextCursor === 'string' ? obj.nextCursor : null;
  const hasMore = typeof obj.hasMore === 'boolean' ? obj.hasMore : nextCursor !== null;

  return { rows, limit, hasMore, nextCursor };
}
