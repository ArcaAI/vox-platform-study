import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';
import { promptKeys } from './prompts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Department {
  id: string;
  code?: string;
  name?: string;
  description?: string;
  parentDepartmentId?: string;
  isRootDepartment: boolean;
  createdAt: string;
  updatedAt: string;
  defaultSummaryTemplate?: string;
  preSummaryPromptId?: string;
  newPatientPromptId?: string;
  revisitPromptId?: string;
  promptConfig?: Record<string, unknown>;
  resourceStatus?: string;
  // TASK-302 Stream D Phase E.2 — row version for optimistic concurrency.
  // The server stamps `ETag: "<version>"` on every Department response,
  // and `If-Match` is required on every PATCH.
  version?: number;
}

export interface CreateDepartmentInput {
  code?: string;
  name?: string;
  description?: string;
  parentDepartmentId?: string;
  // CC-04 (TASK-336) — the create modal collects a default summary template;
  // the backend `CreateDepartmentRequest` now whitelists it (parity with the
  // update path), so it must travel in the create payload too.
  defaultSummaryTemplate?: string;
}

export interface UpdateDepartmentInput {
  code?: string;
  name?: string;
  description?: string;
  parentDepartmentId?: string | null;
  defaultSummaryTemplate?: string;
  preSummaryPromptId?: string;
  newPatientPromptId?: string;
  revisitPromptId?: string;
  promptConfig?: Record<string, unknown>;
  resourceStatus?: string;
  // TASK-302 Stream D Phase E.2 — required CAS predicate (echoed from
  // the prior GET). The controller folds the `If-Match` header value
  // over this when both are present.
  expectedVersion: number;
}

export interface UpdatePromptConfigInput {
  preSummaryPromptId?: string;
  newPatientPromptId?: string;
  revisitPromptId?: string;
  // TASK-302 Stream D Phase E.2 — required CAS predicate (echoed from
  // the prior GET of the Department).
  expectedVersion: number;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

const keys = {
  all: ['admin', 'departments'] as const,
  lists: () => [...keys.all, 'list'] as const,
  list: () => [...keys.lists()] as const,
  roots: () => [...keys.all, 'roots'] as const,
  details: () => [...keys.all, 'detail'] as const,
  detail: (id: string) => [...keys.details(), id] as const,
  children: (parentId: string) => [...keys.all, 'children', parentId] as const,
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useDepartments(options?: Omit<UseQueryOptions<Department[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.list(),
    queryFn: () => adminClient.get<Department[]>('/admin/departments'),
    ...options,
  });
}

export function useRootDepartments(options?: Omit<UseQueryOptions<Department[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.roots(),
    queryFn: () => adminClient.get<Department[]>('/admin/departments/roots'),
    ...options,
  });
}

export function useDepartment(id: string, options?: Omit<UseQueryOptions<Department>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => adminClient.get<Department>(`/admin/departments/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useDepartmentChildren(parentId: string, options?: Omit<UseQueryOptions<Department[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.children(parentId),
    queryFn: () => adminClient.get<Department[]>(`/admin/departments/${parentId}/children`),
    enabled: !!parentId,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDepartmentInput) => adminClient.post<Department>('/admin/departments', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    // TASK-302 Stream D Phase E.2 — `ifMatch` is forwarded as the
    // RFC 7232 `If-Match: "<version>"` request header; the API folds
    // its value over the body-field `expectedVersion`.
    mutationFn: ({ id, ifMatch, ...input }: UpdateDepartmentInput & { id: string; ifMatch?: string }) =>
      adminClient.patch<Department>(`/admin/departments/${id}`, input, ifMatch ? { ifMatch } : undefined),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
    },
  });
}

export function useUpdateDepartmentPromptConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ifMatch, ...input }: UpdatePromptConfigInput & { id: string; ifMatch?: string }) =>
      adminClient.patch<Department>(`/admin/departments/${id}/prompt-config`, input, ifMatch ? { ifMatch } : undefined),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
    },
  });
}

export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<Department>(`/admin/departments/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// Tenant-scoped query keys & hooks
// ---------------------------------------------------------------------------

const tenantKeys = {
  all: (tenantId: string) => ['admin', 'departments', 'tenant', tenantId] as const,
  list: (tenantId: string) => [...tenantKeys.all(tenantId), 'list'] as const,
  detail: (tenantId: string, id: string) => [...tenantKeys.all(tenantId), 'detail', id] as const,
  children: (tenantId: string, parentId: string) => [...tenantKeys.all(tenantId), 'children', parentId] as const,
};

export function useTenantDepartments(tenantId: string, options?: Omit<UseQueryOptions<Department[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: tenantKeys.list(tenantId),
    queryFn: () => adminClient.get<Department[]>('/admin/departments?includeDisabled=true', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useTenantDepartment(tenantId: string, id: string, options?: Omit<UseQueryOptions<Department>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: tenantKeys.detail(tenantId, id),
    queryFn: () => adminClient.get<Department>(`/admin/departments/${id}`, { tenantId }),
    enabled: !!tenantId && !!id,
    ...options,
  });
}

export function useTenantDepartmentChildren(
  tenantId: string,
  parentId: string,
  options?: Omit<UseQueryOptions<Department[]>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: tenantKeys.children(tenantId, parentId),
    queryFn: () => adminClient.get<Department[]>(`/admin/departments/${parentId}/children`, { tenantId }),
    enabled: !!tenantId && !!parentId,
    ...options,
  });
}

export function useCreateTenantDepartment(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDepartmentInput) => adminClient.post<Department>('/admin/departments', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenantKeys.all(tenantId) });
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useUpdateTenantDepartment(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ifMatch, ...input }: UpdateDepartmentInput & { id: string; ifMatch?: string }) =>
      adminClient.patch<Department>(`/admin/departments/${id}`, input, {
        tenantId,
        ...(ifMatch ? { ifMatch } : {}),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: tenantKeys.all(tenantId) });
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({
        queryKey: tenantKeys.detail(tenantId, variables.id),
      });
    },
  });
}

export function useUpdateTenantDepartmentPromptConfig(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ifMatch, ...input }: UpdatePromptConfigInput & { id: string; ifMatch?: string }) =>
      adminClient.patch<Department>(`/admin/departments/${id}/prompt-config`, input, {
        tenantId,
        ...(ifMatch ? { ifMatch } : {}),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: tenantKeys.all(tenantId) });
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({
        queryKey: tenantKeys.detail(tenantId, variables.id),
      });
    },
  });
}

export function useDeleteTenantDepartment(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<Department>(`/admin/departments/${id}`, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tenantKeys.all(tenantId) });
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useRefreshTenantDepartmentDetail(tenantId: string) {
  const qc = useQueryClient();

  return async (departmentId: string) => {
    if (!tenantId || !departmentId) {
      return;
    }

    await Promise.all([
      qc.invalidateQueries({
        queryKey: tenantKeys.detail(tenantId, departmentId),
      }),
      qc.invalidateQueries({
        queryKey: promptKeys.lists(tenantId),
      }),
    ]);
  };
}

export { keys as departmentKeys, tenantKeys as tenantDepartmentKeys };
