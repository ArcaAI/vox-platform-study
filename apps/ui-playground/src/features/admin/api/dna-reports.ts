import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { DnaReport, DnaReportData, DnaStyleVersion } from '@/features/dna-writing-style/api/dna-writing-styles';

import { adminClient, type PaginatedResponse } from './admin-client';
import type { AdminUser } from './users';

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
        // TASK-331 doc-02 F6 — also pass `tenantId` as a query param so a global
        // admin's repo-paginated list is scoped server-side (the header already
        // carries it; the query param keeps parity with the dashboard endpoint).
        adminClient.get<PaginatedResponse<DnaReport>>(
          `/admin/dna-writing-styles?page=1&limit=500&includeDisabled=true&tenantId=${encodeURIComponent(tenantId)}`,
          { tenantId },
        ),
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

export interface AdminDnaUpdateInput {
  reportId: string;
  tenantId: string;
  reportData?: Partial<DnaReportData>;
  styleText?: string;
  changeReason?: string;
  // TASK-331 doc-02 F1 — RFC 7232 `If-Match: "<version>"` forwarded as a request
  // header so the `@RequiresIfMatch()` admin PATCH route runs its compare-and-set
  // (412 on drift, 428 when omitted). Echoed from the loaded report's `version`.
  ifMatch?: string;
}

export function useAdminUpdateDnaReport() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ reportId, tenantId, ifMatch, ...body }: AdminDnaUpdateInput) =>
      adminClient.patch<DnaReport>(`/admin/dna-writing-styles/${reportId}`, body, ifMatch ? { tenantId, ifMatch } : { tenantId }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: dnaReportsAdminKeys.tenantData(variables.tenantId),
      });
      void queryClient.invalidateQueries({
        queryKey: dnaReportsAdminKeys.versions(variables.tenantId, variables.reportId),
      });
    },
  });
}

// CC-05 (TASK-336) — admin-initiated DNA generation. Mirrors the backend admin
// route `POST /admin/dna-writing-styles/generate/:doctorId` (all body fields
// optional; the service gathers text samples from ContextItems when omitted).
// `tenantId` scopes the call to the admin's active tenant (the `X-Tenant-Id`
// header); it travels as a request option, never in the body.
export interface AdminDnaGenerateInput {
  doctorId: string;
  tenantId: string;
  textSamples?: string[];
  promptTemplateId?: string;
  editedSummary?: string;
  sourceIds?: string[];
}

export function useAdminGenerateDnaReport() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ doctorId, tenantId, ...body }: AdminDnaGenerateInput) =>
      adminClient.post<{ jobId: string }>(`/admin/dna-writing-styles/generate/${doctorId}`, body, { tenantId }),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: dnaReportsAdminKeys.tenantData(variables.tenantId),
      });
    },
  });
}
