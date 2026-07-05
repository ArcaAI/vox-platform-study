/** Audit log reads + export (capabilities-matrix row 10). Read-only surface. */

import { getBlob, getJson } from '@/shared/api';
import type { CursorPaginated, Paginated } from '@/shared/api';
import type { AuditLog, AuditLogCursorParams, AuditLogExportParams, AuditLogListParams, AuditResourceType } from './types';

const BASE = 'admin/audit-logs';

export function listAuditLogs(params?: AuditLogListParams): Promise<Paginated<AuditLog>> {
    return getJson(BASE, params);
}

/** Keyset pagination for deep history scans. */
export function listAuditLogsByCursor(params?: AuditLogCursorParams): Promise<CursorPaginated<AuditLog>> {
    return getJson(`${BASE}/cursor`, params);
}

export function getAuditLog(id: string): Promise<AuditLog> {
    return getJson(`${BASE}/${encodeURIComponent(id)}`);
}

export function listResourceAuditLogs(resourceType: AuditResourceType, resourceId: string, params?: AuditLogListParams): Promise<Paginated<AuditLog>> {
    return getJson(`${BASE}/resource/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, params);
}

export function listUserAuditLogs(userId: string, params?: AuditLogListParams): Promise<Paginated<AuditLog>> {
    return getJson(`${BASE}/user/${encodeURIComponent(userId)}`, params);
}

/** File download (csv/xlsx/pdf) — trigger from a user action, not a query. */
export function exportAuditLogs(params: AuditLogExportParams): Promise<{ blob: Blob; contentType: string | null; contentDisposition: string | null }> {
    return getBlob(`${BASE}/export`, params);
}
