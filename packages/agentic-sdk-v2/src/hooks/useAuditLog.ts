/**
 * @arcaai/vox - useAuditLog Hook (QA-003, extended TASK-328 A8)
 *
 * Read-only audit log hook for admin compliance operations. TASK-328 A8 adds
 * repository-pushed filters (date range / action / resourceType / userId), a
 * single-entry `getById`, and a server-side CSV `exportCsv`.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { AUDIT_LOG_ENDPOINTS } from '../core/constants';
import { extractArray, extractPaginated } from '../utils/responseUtils';
import { appendFilters, appendPagination } from '../utils/urlUtils';
import type { PaginationParams } from '../types/common';

export interface AuditLogResponsibleUser {
  id: string;
  displayName?: string | null;
  email?: string | null;
}

export interface AuditLogEntry {
  id: string;
  /** TASK-331 doc-03 F6 — owning tenant id, surfaced so a global-scope console can render a Tenant column. */
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
  /** TASK-328 A8 — resolved acting user (display name/email) for the table. */
  responsibleUser?: AuditLogResponsibleUser | null;
  [key: string]: unknown;
}

/**
 * TASK-328 A8 — audit list/export filter params. Pagination is inherited;
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

export interface UseAuditLogReturn {
  entries: AuditLogEntry[];
  /**
   * TASK-331 doc-03 F11 — total number of audit rows matching the active
   * filters, taken from the paginated envelope so the UI can render true
   * pagination ("Page N of M") instead of guessing from the page length.
   * `0` until the first successful `list()`.
   */
  count: number;
  isLoading: boolean;
  error: Error | null;
  list: (params?: AuditLogFilterParams) => Promise<AuditLogEntry[]>;
  getById: (id: string) => Promise<AuditLogEntry>;
  exportCsv: (filters?: AuditLogFilterParams) => Promise<string>;
  byResource: (resourceType: string, resourceId: string) => Promise<AuditLogEntry[]>;
  byUser: (userId: string) => Promise<AuditLogEntry[]>;
}

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

export function useAuditLog(): UseAuditLogReturn {
  const { execute, isLoading, error } = useApiOperation('useAuditLog');
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [count, setCount] = useState(0);

  const list = useCallback(
    (params?: AuditLogFilterParams) =>
      execute<AuditLogEntry[]>('list', async (client) => {
        const pagination =
          params && (params.page !== undefined || params.limit !== undefined)
            ? { page: params.page, limit: params.limit }
            : undefined;
        const url = appendPagination(appendFilters(AUDIT_LOG_ENDPOINTS.LIST, toFilterQuery(params)), pagination);
        const raw = await client.get(url);
        // TASK-331 doc-03 F11 — read the full paginated envelope so we can keep
        // the real `count` for pagination, while still returning the bare array
        // that existing callers depend on.
        const { data, total } = extractPaginated<AuditLogEntry>(raw);
        setEntries(data);
        setCount(total);
        return data;
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

  return { entries, count, isLoading, error, list, getById, exportCsv, byResource, byUser };
}
