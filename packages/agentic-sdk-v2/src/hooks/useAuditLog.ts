/**
 * @arcaai/vox - useAuditLog Hook (QA-003)
 *
 * Read-only audit log hook for admin compliance operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { AUDIT_LOG_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import type { PaginationParams } from '../types/common';

export interface AuditLogEntry {
  id: string;
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
  [key: string]: unknown;
}

export interface UseAuditLogReturn {
  entries: AuditLogEntry[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<AuditLogEntry[]>;
  get: (id: string) => Promise<AuditLogEntry>;
  byResource: (resourceType: string, resourceId: string) => Promise<AuditLogEntry[]>;
  byUser: (userId: string) => Promise<AuditLogEntry[]>;
}

export function useAuditLog(): UseAuditLogReturn {
  const { execute, isLoading, error } = useApiOperation('useAuditLog');
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<AuditLogEntry[]>('list', async (client) => {
        const raw = await client.get(appendPagination(AUDIT_LOG_ENDPOINTS.LIST, pagination));
        const result = extractArray<AuditLogEntry>(raw);
        setEntries(result);
        return result;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) => execute<AuditLogEntry>('get', (client) => client.get<AuditLogEntry>(AUDIT_LOG_ENDPOINTS.GET(id))),
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

  return { entries, isLoading, error, list, get, byResource, byUser };
}
