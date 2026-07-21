/**
 * @arcaai/vox - useAuditLog Hook (QA-003)
 *
 * Read-only audit log hook for admin compliance operations. Adds
 * repository-pushed filters (date range / action / resourceType / userId), a
 * single-entry `getById`, and a server-side CSV `exportCsv`.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { AUDIT_LOG_ENDPOINTS } from '../core/constants';
import { extractArray, extractPaginated, extractCursorPaginated } from '../utils/responseUtils';
import type { CursorPageResult } from '../utils/responseUtils';
import { appendFilters, appendPagination } from '../utils/urlUtils';
import { DEFAULT_PAGE_SIZE } from '../types/common';
import type { PaginationParams } from '../types/common';

export interface AuditLogResponsibleUser {
  id: string;
  displayName?: string | null;
  email?: string | null;
}

export interface AuditLogEntry {
  id: string;
  /** Owning tenant id, surfaced so a global-scope console can render a Tenant column. */
  tenantId?: string | null;
  responsibleUserId?: string | null;
  responsibleIp?: string | null;
  resourceType?: string;
  resourceId?: string | null;
  action?: string;
  eventType?: string | null;
  success?: boolean | null;
  data?: unknown;
  previousData?: unknown;
  metadata?: unknown;
  correlationId?: string | null;
  causationId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Resolved acting user (display name/email) for the table. */
  responsibleUser?: AuditLogResponsibleUser | null;
  [key: string]: unknown;
}

/**
 * Audit list/export filter params. Pagination is inherited;
 * the rest are pushed to the server `where` clause. `from`/`to` are ISO-8601
 * boundary strings.
 */
export interface AuditLogFilterParams extends PaginationParams {
  from?: string;
  to?: string;
  action?: string;
  resourceType?: string;
  userId?: string;
}

/**
 * Cursor (keyset) audit-log query, the cursor
 * sibling of {@link AuditLogFilterParams}. Mirrors the server `CursorQuery`
 * (opaque `cursor` token + `limit`) and carries the SAME A8 filters the offset
 * `list()` supports (`from`/`to`/`action`/`resourceType`/`userId`), pushed to
 * the repository `where` clause. There is no offset `page`/`sort` — keyset
 * order is fixed to `(createdAt, id)` DESC server-side.
 */
export interface AuditLogCursorParams {
  /** Opaque cursor token from the previous page's `nextCursor`; omit/`null` on the first page. */
  cursor?: string | null;
  /** Items per page; defaults to {@link DEFAULT_PAGE_SIZE} when omitted (server clamps to 1–100). */
  limit?: number;
  from?: string;
  to?: string;
  action?: string;
  resourceType?: string;
  userId?: string;
}

export interface UseAuditLogReturn {
  entries: AuditLogEntry[];
  /**
   * Total number of audit rows matching the active
   * filters, taken from the paginated envelope so the UI can render true
   * pagination ("Page N of M") instead of guessing from the page length.
   * `0` until the first successful `list()`.
   */
  count: number;
  isLoading: boolean;
  error: Error | null;
  list: (params?: AuditLogFilterParams) => Promise<AuditLogEntry[]>;
  /**
   * Cursor (keyset) sibling of {@link list}. Calls
   * `GET /admin/audit-logs/cursor` and returns the server
   * `CursorPaginatedResponse` normalized via `extractCursorPaginated` into the
   * client `PageResult`-shaped cursor page (`{ rows, nextCursor, hasMore, limit }`).
   * Unlike {@link list} it does NOT touch the offset `entries`/`count` state —
   * cursor consumers accumulate rows across pages themselves.
   */
  listByCursor: (query?: AuditLogCursorParams) => Promise<CursorPageResult<AuditLogEntry>>;
  getById: (id: string) => Promise<AuditLogEntry>;
  exportCsv: (filters?: AuditLogFilterParams) => Promise<string>;
  /**
   * Export the filtered set as a binary file (`xlsx`/`pdf`,
   * or `csv` as a Blob) for a browser download. Hits the SAME
   * `GET /admin/audit-logs/export` route as {@link exportCsv} with `?format=`,
   * honouring the same A8 filters + tenant scope. Returns the raw `Blob` (via
   * `getBlob`); the caller triggers the download. For CSV-as-text keep using
   * {@link exportCsv}.
   */
  exportFile: (format: AuditExportFormat, filters?: AuditLogFilterParams) => Promise<Blob>;
  byResource: (resourceType: string, resourceId: string) => Promise<AuditLogEntry[]>;
  byUser: (userId: string) => Promise<AuditLogEntry[]>;
}

/** Binary export formats for {@link UseAuditLogReturn.exportFile}. */
export type AuditExportFormat = 'csv' | 'xlsx' | 'pdf';

/** Extract only the server-side filter params (skip pagination keys). */
function toFilterQuery(params?: AuditLogFilterParams): Record<string, string | undefined> {
  return {
    from: params?.from,
    to: params?.to,
    action: params?.action,
    resourceType: params?.resourceType,
    userId: params?.userId,
  };
}

/**
 * Build the cursor query record (cursor + limit + the same A8 filters). The
 * `cursor` is omitted on the first page (`null`/`undefined`); `limit` always
 * emitted (defaulting to {@link DEFAULT_PAGE_SIZE}). Fed to the same
 * `appendFilters` helper the offset path uses for its filters.
 */
function toCursorFilterQuery(query?: AuditLogCursorParams): Record<string, string | undefined> {
  return {
    cursor: query?.cursor ?? undefined,
    limit: String(query?.limit ?? DEFAULT_PAGE_SIZE),
    from: query?.from,
    to: query?.to,
    action: query?.action,
    resourceType: query?.resourceType,
    userId: query?.userId,
  };
}

export function useAuditLog(): UseAuditLogReturn {
  const { execute, isLoading, error } = useApiOperation('useAuditLog');
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [count, setCount] = useState(0);

  const list = useCallback(
    (params?: AuditLogFilterParams) =>
      execute<AuditLogEntry[]>('list', async (client) => {
        const pagination =
          params && (params.page !== undefined || params.limit !== undefined) ? { page: params.page, limit: params.limit } : undefined;
        const url = appendPagination(appendFilters(AUDIT_LOG_ENDPOINTS.LIST, toFilterQuery(params)), pagination);
        const raw = await client.get(url);
        // Read the full paginated envelope so we can keep
        // the real `count` for pagination, while still returning the bare array
        // that existing callers depend on.
        const { data, total } = extractPaginated<AuditLogEntry>(raw);
        setEntries(data);
        setCount(total);
        return data;
      }),
    [execute],
  );

  const listByCursor = useCallback(
    (query?: AuditLogCursorParams) =>
      execute<CursorPageResult<AuditLogEntry>>('listByCursor', async (client) => {
        // Keyset sibling of `list()`: same `appendFilters` builder, but against
        // the cursor endpoint with a `cursor`/`limit` contract (no `page`).
        const url = appendFilters(AUDIT_LOG_ENDPOINTS.CURSOR, toCursorFilterQuery(query));
        const raw = await client.get(url);
        return extractCursorPaginated<AuditLogEntry>(raw);
      }),
    [execute],
  );

  const getById = useCallback(
    (id: string) => execute<AuditLogEntry>('getById', (client) => client.get<AuditLogEntry>(AUDIT_LOG_ENDPOINTS.GET(id))),
    [execute],
  );

  const exportCsv = useCallback(
    (filters?: AuditLogFilterParams) =>
      execute<string>('exportCsv', (client) => {
        const url = appendFilters(AUDIT_LOG_ENDPOINTS.EXPORT, toFilterQuery(filters));
        return client.getCsv(url);
      }),
    [execute],
  );

  // Binary export (xlsx/pdf, or csv-as-Blob). Same EXPORT
  // route + A8 filters as `exportCsv`, with `?format=` selecting the renderer;
  // returns the raw bytes as a Blob for the caller to download.
  const exportFile = useCallback(
    (format: AuditExportFormat, filters?: AuditLogFilterParams) =>
      execute<Blob>('exportFile', (client) => {
        const url = appendFilters(AUDIT_LOG_ENDPOINTS.EXPORT, { format, ...toFilterQuery(filters) });
        return client.getBlob(url);
      }),
    [execute],
  );

  const byResource = useCallback(
    (resourceType: string, resourceId: string) =>
      execute<AuditLogEntry[]>('byResource', async (client) => {
        const raw = await client.get(AUDIT_LOG_ENDPOINTS.BY_RESOURCE(resourceType, resourceId));
        return extractArray<AuditLogEntry>(raw);
      }),
    [execute],
  );

  const byUser = useCallback(
    (userId: string) =>
      execute<AuditLogEntry[]>('byUser', async (client) => {
        const raw = await client.get(AUDIT_LOG_ENDPOINTS.BY_USER(userId));
        return extractArray<AuditLogEntry>(raw);
      }),
    [execute],
  );

  return { entries, count, isLoading, error, list, listByCursor, getById, exportCsv, exportFile, byResource, byUser };
}
