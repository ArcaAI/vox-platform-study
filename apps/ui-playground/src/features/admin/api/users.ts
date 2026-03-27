import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  avatarId?: string | null;
}

export interface UserRoleAssignmentInfo {
  id: string;
  roleId: string;
  roleName?: string;
  tenantId?: string;
  resourceStatus?: string;
}

export interface AdminUser {
  id: string;
  username: string;
  email?: string;
  externalId?: string;
  tenantId?: string;
  isServiceAccount: boolean;
  resourceStatus?: string;
  resourceStatusUpdatedAt?: string;
  resourceStatusUpdatedBy?: string;
  primaryDepartmentId?: string;
  departmentIds?: string[];
  lastLoginAt?: string;
  lastActiveAt?: string;
  secret1?: string;
  secret1Expiry?: string;
  secret2?: string;
  secret2Expiry?: string;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  UserProfile?: UserProfile | null;
  UserRoleAssignments?: UserRoleAssignmentInfo[];
  [key: string]: unknown;
}

export interface CreateUserInput {
  username: string;
  email?: string;
  password?: string;
  externalId?: string;
  tenantId?: string;
  isServiceAccount?: boolean;
  [key: string]: unknown;
}

export interface UpdateUserInput {
  username?: string;
  email?: string;
  externalId?: string | null;
  resourceStatus?: string;
  isServiceAccount?: boolean;
  [key: string]: unknown;
}

export interface UpdateUserStatusInput {
  resourceStatus: string;
}

export interface UserApiKey {
  id: string;
  userId?: string;
  keyName: string;
  keyPrefix: string;
  keyType: string;
  keyStatus: string;
  scopes?: string[] | null;
  allowedIps?: string[] | null;
  rateLimit?: number | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  usageCount: number;
  description?: string | null;
  environment?: string | null;
  resourceStatus?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
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
  all: ['admin', 'users'] as const,
  lists: () => [...keys.all, 'list'] as const,
  list: (params?: PaginationParams) => [...keys.lists(), params] as const,
  details: () => [...keys.all, 'detail'] as const,
  detail: (id: string) => [...keys.details(), id] as const,
  byTenant: (tenantId: string, params?: PaginationParams) => [...keys.all, 'tenant', tenantId, params] as const,
  apiKeys: (userId: string, params?: PaginationParams) => [...keys.all, 'api-keys', userId, params] as const,
  settings: (userId: string) => [...keys.all, 'settings', userId] as const,
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

export function useAdminUsers(params?: PaginationParams, options?: Omit<UseQueryOptions<PaginatedResponse<AdminUser>>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.list(params),
    queryFn: () => adminClient.get<PaginatedResponse<AdminUser>>(`/admin/users${qs(params)}`),
    ...options,
  });
}

export function useAdminUser(id: string, options?: Omit<UseQueryOptions<AdminUser>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => adminClient.get<AdminUser>(`/admin/users/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useAdminUsersByTenant(
  tenantId: string,
  params?: PaginationParams,
  options?: Omit<UseQueryOptions<PaginatedResponse<AdminUser>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.byTenant(tenantId, params),
    queryFn: () => adminClient.get<PaginatedResponse<AdminUser>>(`/admin/users/tenant/${tenantId}${qs(params)}`),
    enabled: !!tenantId,
    ...options,
  });
}

export function useUserApiKeys(
  userId: string,
  params?: PaginationParams,
  options?: Omit<UseQueryOptions<PaginatedResponse<UserApiKey>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.apiKeys(userId, params),
    queryFn: () => adminClient.get<PaginatedResponse<UserApiKey>>(`/admin/users/${userId}/api-keys${qs(params)}`),
    enabled: !!userId,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) => adminClient.post<AdminUser>('/admin/users', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateUserInput & { id: string }) => adminClient.patch<AdminUser>(`/admin/users/${id}`, input),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
    },
  });
}

export function useUpdateUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateUserStatusInput & { id: string }) => adminClient.patch<AdminUser>(`/admin/users/${id}/status`, input),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
    },
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<void>(`/admin/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useBulkDeleteUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => adminClient.deleteWithBody<void>('/admin/users/bulk', { ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (apiKeyId: string) => adminClient.post<UserApiKey>(`/admin/api-keys/${apiKeyId}/revoke`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

// ---------------------------------------------------------------------------
// TASK-245: Admin user settings
// ---------------------------------------------------------------------------

export interface UserSetting {
  id: string;
  name: string;
  key: string;
  value: string;
  dataType?: string;
  namespace?: string | null;
  userId?: string;
  [k: string]: unknown;
}

export function useAdminUserSettings(userId: string, options?: Omit<UseQueryOptions<UserSetting[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.settings(userId),
    queryFn: () => adminClient.get<UserSetting[]>(`/admin/users/${userId}/settings`),
    enabled: !!userId,
    ...options,
  });
}

export function useUpdateAdminUserSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      namespace,
      key,
      value,
      dataType,
      name,
    }: {
      userId: string;
      namespace: string;
      key: string;
      value: string;
      dataType?: string;
      name?: string;
    }) => adminClient.patch<UserSetting>(`/admin/users/${userId}/settings/${namespace}/${key}`, { value, dataType, name }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.settings(variables.userId) });
    },
  });
}

export { keys as userKeys };
