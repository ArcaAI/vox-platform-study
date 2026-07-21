/**
 * Cross-component pagination contracts.
 *
 * Transport-agnostic (D5): these are plain data shapes + normalizers, with no
 * fetch/react-query coupling. They align with the SDK's `extractPaginated`
 * output (the shape consuming hooks actually return) and the raw NestJS
 * `{ data, count, page, limit }` envelope.
 */

/** Offset request — `page` is 0-based to match the backend `PaginatedQuery`. */
export interface OffsetPageRequest {
  mode: 'offset';
  page: number;
  limit: number;
}

/** Cursor request — INERT today (no server cursor contract exists, D7). */
export interface CursorPageRequest {
  mode: 'cursor';
  cursor: string | null;
  limit: number;
}

export type PageRequest = OffsetPageRequest | CursorPageRequest;

/** Normalized client page result consumed by the grid + timeline. */
export interface PageResult<T> {
  rows: T[];
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  hasMore?: boolean;
  /** Cursor mode only — inert until lands a server cursor contract (D7). */
  nextCursor?: string | null;
}

/** The shape `@arcaai/vox` `extractPaginated()` returns. */
export interface SdkPaginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasMore: boolean;
}

/** The raw NestJS list envelope (`PaginatedResponse<T>` and friends). */
export interface ServerPaginated<T> {
  data: T[];
  count: number;
  page: number;
  limit: number;
}

/**
 * Primary normalizer — aligns with the SDK's `extractPaginated` output, which
 * is what consuming hooks already return.
 */
export function fromSdkPaginated<T>(r: SdkPaginated<T>): PageResult<T> {
  return {
    rows: r.data,
    total: r.total,
    page: r.page,
    limit: r.limit,
    totalPages: r.totalPages,
    hasMore: r.hasMore,
  };
}

/**
 * Raw-server fallback (when bypassing the SDK). Computes `totalPages`/`hasMore`
 * client-side. `PaginatedQuery.page` is 0-based, but `ContextFiltersDto` /
 * `PaginatedContextItemResponse.page` are 1-based — pass `{ pageBase: 1 }` to
 * normalize those to the internal 0-based `page`.
 */
export function fromServerPaginated<T>(r: ServerPaginated<T>, opts?: { pageBase?: 0 | 1 }): PageResult<T> {
  const pageBase = opts?.pageBase ?? 0;
  const zeroBasedPage = pageBase === 1 ? Math.max(0, r.page - 1) : r.page;
  const totalPages = r.limit > 0 ? Math.ceil(r.count / r.limit) : 0;
  const hasMore = r.limit > 0 ? (zeroBasedPage + 1) * r.limit < r.count : false;
  return {
    rows: r.data,
    total: r.count,
    page: zeroBasedPage,
    limit: r.limit,
    totalPages,
    hasMore,
  };
}
