import type { AuditLogCursorParams, AuditLogListParams, AuditResourceType } from './types';

export const auditLogKeys = {
  root: ['audit-logs'] as const,
  list: (params?: AuditLogListParams) => [...auditLogKeys.root, 'list', params ?? {}] as const,
  cursor: (params?: AuditLogCursorParams) => [...auditLogKeys.root, 'cursor', params ?? {}] as const,
  detail: (id: string) => [...auditLogKeys.root, 'detail', id] as const,
  byResource: (resourceType: AuditResourceType, resourceId: string, params?: AuditLogListParams) =>
    [...auditLogKeys.root, 'resource', resourceType, resourceId, params ?? {}] as const,
  byUser: (userId: string, params?: AuditLogListParams) => [...auditLogKeys.root, 'user', userId, params ?? {}] as const,
};
