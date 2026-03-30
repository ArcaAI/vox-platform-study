import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { DnaReport, DnaStyleVersion } from '@/features/dna-writing-style/api/dna-writing-styles';

import { adminClient } from './admin-client';
import type { AdminUser } from './users';

interface PaginatedResponse<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

export interface TenantDnaReportData {
  users: AdminUser[];
  reports: DnaReport[];
}

export const dnaReportsAdminKeys = {
  all: ['dna-reports-admin'] as const,
  tenantData: (tenantId: string) => [...dnaReportsAdminKeys.all, 'tenant-data', tenantId] as const,
  versions: (tenantId: string, reportId: string) => [...dnaReportsAdminKeys.all, 'versions', tenantId, reportId] as const,
};

export function useTenantDnaReportData(tenantId: string) {
  return useQuery({
    queryKey: dnaReportsAdminKeys.tenantData(tenantId || 'none'),
    enabled: !!tenantId,
    staleTime: 30_000,
    queryFn: async (): Promise<TenantDnaReportData> => {
      if (!tenantId) {
        return { users: [], reports: [] };
      }

      const [usersResponse, reportsResponse] = await Promise.all([
        adminClient.get<PaginatedResponse<AdminUser>>(`/admin/users/tenant/${tenantId}?page=1&limit=100`, { tenantId }),
        adminClient.get<PaginatedResponse<DnaReport>>('/admin/dna-writing-styles?page=1&limit=500&includeDisabled=true', { tenantId }),
      ]);

      return {
        users: (usersResponse.data ?? []).filter((user) => !user.isServiceAccount),
        reports: reportsResponse.data ?? [],
      };
    },
  });
}

export function useDnaReportVersions(tenantId: string, reportId: string) {
  return useQuery({
    queryKey: dnaReportsAdminKeys.versions(tenantId || 'none', reportId || 'none'),
    enabled: !!tenantId && !!reportId,
    staleTime: 30_000,
    queryFn: async (): Promise<DnaStyleVersion[]> => {
      if (!tenantId || !reportId) {
        return [];
      }

      const response = await adminClient.get<DnaStyleVersion[]>(`/admin/dna-writing-styles/${reportId}/versions`, { tenantId });

      return [...response].sort((a, b) => b.versionNumber - a.versionNumber);
    },
  });
}

export function useRefreshTenantDnaReportData() {
  const queryClient = useQueryClient();

  return useCallback(
    async (tenantId: string) => {
      if (!tenantId) {
        return;
      }

      await queryClient.invalidateQueries({
        queryKey: dnaReportsAdminKeys.tenantData(tenantId),
      });
    },
    [queryClient],
  );
}

export function useRefreshDnaReportVersions() {
  const queryClient = useQueryClient();

  return useCallback(
    async (tenantId: string, reportId: string) => {
      if (!tenantId || !reportId) {
        return;
      }

      await queryClient.invalidateQueries({
        queryKey: dnaReportsAdminKeys.versions(tenantId, reportId),
      });
    },
    [queryClient],
  );
}
