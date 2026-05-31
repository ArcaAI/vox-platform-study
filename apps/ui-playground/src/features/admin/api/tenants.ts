import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Tenant {
  id: string;
  name: string;
  key: string;
  resourceStatus: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface TenantUsage {
  totalUsers: number;
  totalDepartments: number;
  totalPromptTemplates: number;
  totalPipelines: number;
  [key: string]: unknown;
}

export interface TenantConfig {
  id: string;
  name: string;
  description?: string | null;
  key: string;
  defaultValue?: string | null;
  /**
   * Row version surfaced by the API after TASK-302 Stream D Phase B.6.
   * Optional on the wire because legacy callers (and unversioned rows
   * during the rollout window) may omit it. The PATCH path will fail
   * with `428 Precondition Required` if the corresponding `If-Match`
   * header is missing, so the editor MUST capture this value on GET
   * and surface it on save.
   */
  version?: number;
  value: string;
  dataType?: string;
  namespace?: string | null;
  tenantId?: string;
  tenantCode?: string;
  resourceStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface CreateTenantInput {
  name: string;
  key: string;
  [key: string]: unknown;
}

export interface UpdateTenantInput {
  name?: string;
  resourceStatus?: string;
  [key: string]: unknown;
}

export interface UpdateTenantConfigItem {
  id: string;
  value: string;
  description?: string;
  /**
   * Row-version snapshot the editor was looking at when the user pressed
   * Save. Required by the API DTO after TASK-302 Stream D Phase C.1; the
   * server runs a Compare-And-Set against the stored `_version` and
   * returns `412 Precondition Failed` on drift. Keep this in sync with
   * `If-Match` (the header takes precedence on the same call — see
   * `useUpdateMyTenantConfigs` for the wiring).
   */
  expectedVersion: number;
}

export interface UpdateTenantConfigsInput {
  configs: UpdateTenantConfigItem[];
}

interface PaginatedResponse<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

interface PaginationParams {
  page?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const keys = {
  all: ['admin', 'tenants'] as const,
  lists: () => [...keys.all, 'list'] as const,
  list: (params?: PaginationParams) => [...keys.lists(), params] as const,
  details: () => [...keys.all, 'detail'] as const,
  detail: (id: string) => [...keys.details(), id] as const,
  usage: (id: string) => [...keys.all, 'usage', id] as const,
  configs: (identifier: string, params?: PaginationParams) => [...keys.all, 'configs', identifier, params] as const,
};

function qs(params?: PaginationParams): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useTenants(params?: PaginationParams, options?: Omit<UseQueryOptions<PaginatedResponse<Tenant>>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.list(params),
    queryFn: () => adminClient.get<PaginatedResponse<Tenant>>(`/admin/tenants${qs(params)}`),
    ...options,
  });
}

const DEFAULT_INFINITE_PAGE_SIZE = 25;

export function useTenantsInfinite(
  pageSize = DEFAULT_INFINITE_PAGE_SIZE,
  options?: {
    enabled?: boolean;
    refetchOnWindowFocus?: boolean;
    refetchOnReconnect?: boolean;
  },
) {
  return useInfiniteQuery({
    queryKey: [...keys.lists(), 'infinite', pageSize] as const,
    queryFn: ({ pageParam }) => adminClient.get<PaginatedResponse<Tenant>>(`/admin/tenants${qs({ page: pageParam, limit: pageSize })}`),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      const fetched = lastPageParam * pageSize;
      return fetched < lastPage.count ? lastPageParam + 1 : undefined;
    },
    ...options,
  });
}

export function useTenant(id: string, options?: Omit<UseQueryOptions<Tenant>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => adminClient.get<Tenant>(`/admin/tenants/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useTenantUsage(id: string, options?: Omit<UseQueryOptions<TenantUsage>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.usage(id),
    queryFn: () => adminClient.get<TenantUsage>(`/admin/tenants/${id}/usage`),
    enabled: !!id,
    ...options,
  });
}

export function useTenantConfigs(
  identifier: string,
  params?: PaginationParams,
  options?: Omit<UseQueryOptions<PaginatedResponse<TenantConfig>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.configs(identifier, params),
    queryFn: () => adminClient.get<PaginatedResponse<TenantConfig>>(`/admin/tenants/configs/${identifier}${qs(params)}`),
    enabled: !!identifier,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTenantInput) => adminClient.post<Tenant>('/admin/tenants', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.lists() });
    },
  });
}

export function useUpdateTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateTenantInput & { id: string }) => adminClient.patch<Tenant>(`/admin/tenants/${id}`, input),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
    },
  });
}

export function useToggleTenantStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resourceStatus }: { id: string; resourceStatus: string }) =>
      adminClient.patch<Tenant>(`/admin/tenants/${id}`, { resourceStatus }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
    },
  });
}

export function useDeleteTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<void>(`/admin/tenants/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.lists() });
    },
  });
}

export function useUpdateTenantConfigs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ identifier, configs, ifMatch }: { identifier: string; configs: UpdateTenantConfigItem[]; ifMatch?: string }) =>
      adminClient.patch<PaginatedResponse<TenantConfig>>(`/admin/tenants/configs/${identifier}`, configs, ifMatch ? { ifMatch } : undefined),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({
        queryKey: keys.configs(variables.identifier),
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Auth-based tenant config (uses JWT, no tenant ID required)
// ---------------------------------------------------------------------------

const myTenantKeys = {
  config: ['my-tenant', 'config'] as const,
};

export function useMyTenantConfigs(options?: Omit<UseQueryOptions<PaginatedResponse<TenantConfig>>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: myTenantKeys.config,
    queryFn: () => adminClient.get<PaginatedResponse<TenantConfig>>('/tenant/me/config'),
    ...options,
  });
}

export function useUpdateMyTenantConfigs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configs, ifMatch }: { configs: UpdateTenantConfigItem[]; ifMatch?: string }) =>
      adminClient.patch<PaginatedResponse<TenantConfig>>('/tenant/me/config', configs, ifMatch ? { ifMatch } : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: myTenantKeys.config });
    },
  });
}

export { keys as tenantKeys };
