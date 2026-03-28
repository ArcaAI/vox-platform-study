import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types — aligned with backend AuditLogResponse
// ---------------------------------------------------------------------------

export interface AuditLog {
  id: string;
  tenantId?: string;
  responsibleUserId?: string | null;
  responsibleIp?: string | null;
  resourceType: string;
  resourceId?: string | null;
  action: string;
  eventType?: string | null;
  success?: boolean | null;
  data?: unknown;
  previousData?: unknown;
  metadata?: unknown;
  resourceStatus?: string;
  createdAt: string;
  updatedAt?: string;
  createdBy?: string;
  [key: string]: unknown;
}

export interface AuditLogParams {
  page?: number;
  limit?: number;
  search?: string;
  filters?: string;
  sort?: string;
}

interface PaginatedResponse<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const keys = {
  all: ['admin', 'audit-logs'] as const,
  lists: () => [...keys.all, 'list'] as const,
  list: (params?: AuditLogParams) => [...keys.lists(), params] as const,
  details: () => [...keys.all, 'detail'] as const,
  detail: (id: string) => [...keys.details(), id] as const,
  byResource: (resourceType: string, resourceId: string) => [...keys.all, 'resource', resourceType, resourceId] as const,
  byUser: (userId: string) => [...keys.all, 'user', userId] as const,
  byTenant: (tenantId: string, params?: AuditLogParams) => [...keys.all, 'tenant', tenantId, params] as const,
};

function qs(params?: AuditLogParams): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useAuditLogs(params?: AuditLogParams, options?: Omit<UseQueryOptions<PaginatedResponse<AuditLog>>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.list(params),
    queryFn: () => adminClient.get<PaginatedResponse<AuditLog>>(`/admin/audit-logs${qs(params)}`),
    ...options,
  });
}

export function useTenantAuditLogs(
  tenantId: string,
  params?: Omit<AuditLogParams, 'filters'>,
  options?: Omit<UseQueryOptions<PaginatedResponse<AuditLog>>, 'queryKey' | 'queryFn'>,
) {
  const fullParams: AuditLogParams = {
    ...params,
    filters: `tenantId[equals]:${tenantId}`,
    sort: 'createdAt:desc',
  };
  return useQuery({
    queryKey: keys.byTenant(tenantId, fullParams),
    queryFn: () => adminClient.get<PaginatedResponse<AuditLog>>(`/admin/audit-logs${qs(fullParams)}`),
    enabled: !!tenantId,
    ...options,
  });
}

export function useAuditLog(id: string, options?: Omit<UseQueryOptions<AuditLog>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => adminClient.get<AuditLog>(`/admin/audit-logs/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useAuditLogsByResource(
  resourceType: string,
  resourceId: string,
  params?: AuditLogParams,
  options?: Omit<UseQueryOptions<PaginatedResponse<AuditLog>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.byResource(resourceType, resourceId),
    queryFn: () => adminClient.get<PaginatedResponse<AuditLog>>(`/admin/audit-logs/resource/${resourceType}/${resourceId}${qs(params)}`),
    enabled: !!resourceType && !!resourceId,
    ...options,
  });
}

export function useAuditLogsByUser(
  userId: string,
  params?: AuditLogParams,
  options?: Omit<UseQueryOptions<PaginatedResponse<AuditLog>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.byUser(userId),
    queryFn: () => adminClient.get<PaginatedResponse<AuditLog>>(`/admin/audit-logs/user/${userId}${qs(params)}`),
    enabled: !!userId,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useDeleteAuditLog() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<void>(`/admin/audit-logs/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export { keys as auditLogKeys };
