'use client';

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { exportAuditLogs, getAuditLog, listAuditLogs, listAuditLogsByCursor, listResourceAuditLogs, listUserAuditLogs } from './client';
import { auditLogKeys } from './keys';
import type { AuditLogCursorParams, AuditLogExportParams, AuditLogListParams, AuditResourceType } from './types';

export function useAuditLogs(params?: AuditLogListParams) {
  return useQuery({ queryKey: auditLogKeys.list(params), queryFn: () => listAuditLogs(params), placeholderData: keepPreviousData });
}

export function useAuditLogsCursor(params?: AuditLogCursorParams) {
  return useQuery({ queryKey: auditLogKeys.cursor(params), queryFn: () => listAuditLogsByCursor(params), placeholderData: keepPreviousData });
}

export function useAuditLog(id: string) {
  return useQuery({ queryKey: auditLogKeys.detail(id), queryFn: () => getAuditLog(id), enabled: !!id });
}

export function useResourceAuditLogs(resourceType: AuditResourceType, resourceId: string, params?: AuditLogListParams) {
  return useQuery({
    queryKey: auditLogKeys.byResource(resourceType, resourceId, params),
    queryFn: () => listResourceAuditLogs(resourceType, resourceId, params),
    enabled: !!resourceType && !!resourceId,
    placeholderData: keepPreviousData,
  });
}

export function useUserAuditLogs(userId: string, params?: AuditLogListParams) {
  return useQuery({
    queryKey: auditLogKeys.byUser(userId, params),
    queryFn: () => listUserAuditLogs(userId, params),
    enabled: !!userId,
    placeholderData: keepPreviousData,
  });
}

/** Export is a user-triggered download, so it's a mutation, not a query. */
export function useExportAuditLogs() {
  return useMutation({ mutationFn: (params: AuditLogExportParams) => exportAuditLogs(params) });
}
