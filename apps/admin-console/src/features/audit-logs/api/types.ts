import type { BaseResource, ListParams } from '@/shared/api';

export type AuditAction = 'CREATE' | 'READ' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'LOGIN' | 'LOGOUT' | 'IMPERSONATED_ACTION';

/** Gateway ResourceType enum (40 values) — kept open, values pass through. */
export type AuditResourceType = string;

export type AuditExportFormat = 'csv' | 'xlsx' | 'pdf';

/** GET /admin/audit-logs rows (AuditLogResponse). */
export interface AuditLog extends BaseResource {
    tenantId: string;
    responsibleUserId: string | null;
    responsibleIp: string | null;
    resourceType: AuditResourceType;
    resourceId: string | null;
    action: AuditAction;
    eventType: string | null;
    success: boolean | null;
    data: unknown;
    previousData: unknown;
    metadata: unknown;
    responsibleUser: { id: string; displayName: string | null; email: string | null } | null;
}

/** Offset list query (AuditLogQuery extends PaginatedQuery). */
export interface AuditLogListParams extends ListParams {
    /** ISO date-time lower bound. */
    from?: string;
    /** ISO date-time upper bound. */
    to?: string;
    action?: AuditAction;
    resourceType?: AuditResourceType;
    userId?: string;
}

/** Keyset query for deep scans (AuditLogCursorQuery). */
export interface AuditLogCursorParams {
    cursor?: string;
    limit?: number;
    filters?: string;
    from?: string;
    to?: string;
    action?: AuditAction;
    resourceType?: AuditResourceType;
    userId?: string;
    [key: string]: string | number | boolean | undefined | null;
}

export interface AuditLogExportParams extends AuditLogListParams {
    format: AuditExportFormat;
}
