import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
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

/**
 * OB-06 (TASK-336) — the one canonical list envelope for the audit/observability
 * admin client. The backend audit endpoints already return `{ data, count, limit,
 * page }`, but consumers read `data`/`count` directly, so a single drifted field
 * (e.g. `total` instead of `count`) would silently show 0 rows/totals. We pin the
 * shape here so the rest of the admin console can depend on it.
 */
export interface AuditLogListEnvelope<T = AuditLog> {
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
  byTenant: (tenantId: string, params?: AuditLogParams) => [...keys.all, 'tenant', tenantId, params] as const,
};

function qs(params?: AuditLogParams): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * OB-06 (TASK-336) — normalize any audit list response onto
 * {@link AuditLogListEnvelope}. Tolerates the historical envelope variants
 * (`count`/`total`, `limit`/`pageSize`, `data`/`items`) so the admin console
 * keeps working if an endpoint drifts. Scoped to the audit client only.
 */
export function normalizeAuditLogList(raw: unknown): AuditLogListEnvelope {
  const source = (raw ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(source.data) ? (source.data as AuditLog[]) : Array.isArray(source.items) ? (source.items as AuditLog[]) : [];

  return {
    data: rows,
    count: asNumber(source.count) ?? asNumber(source.total) ?? rows.length,
    limit: asNumber(source.limit) ?? asNumber(source.pageSize) ?? rows.length,
    page: asNumber(source.page) ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/**
 * The single audit-log list client (OB-09): the tenant-scoped list used by the
 * admin tenant drawer. All responses pass through {@link normalizeAuditLogList}.
 */
export function useTenantAuditLogs(
  tenantId: string,
  params?: Omit<AuditLogParams, 'filters'>,
  options?: Omit<UseQueryOptions<AuditLogListEnvelope>, 'queryKey' | 'queryFn'>,
) {
  const fullParams: AuditLogParams = {
    ...params,
    filters: `tenantId[equals]:${tenantId}`,
    sort: 'createdAt:desc',
  };
  return useQuery({
    queryKey: keys.byTenant(tenantId, fullParams),
    queryFn: async () => normalizeAuditLogList(await adminClient.get<unknown>(`/admin/audit-logs${qs(fullParams)}`)),
    enabled: !!tenantId,
    ...options,
  });
}

export { keys as auditLogKeys };
