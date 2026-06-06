import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient, type PaginatedResponse } from './admin-client';

// ---------------------------------------------------------------------------
// Types — aligned with backend RoleResponse / RolesController
// ---------------------------------------------------------------------------

export interface Role {
  id: string;
  name: string;
  description?: string | null;
  externalName?: string | null;
  externalId?: string | null;
  isSystemRole?: boolean;
  parentRoleId?: string | null;
  resourceStatus?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  externalName?: string;
  externalId?: string;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  externalName?: string;
  externalId?: string;
  resourceStatus?: string;
}

export interface UserRoleAssignment {
  id: string;
  userId: string;
  roleId: string;
  tenantId?: string;
  roleName?: string;
  resourceStatus?: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface CreateUserRoleAssignmentInput {
  userId: string;
  roleId: string;
  tenantId?: string;
}

interface PaginationParams {
  page?: number;
  limit?: number;
  search?: string;
}

/**
 * AC-04 (TASK-336): the RBAC controllers (`/admin/rbac/roles`, `/policies`) do
 * NOT speak the admin `{ count, limit }` envelope — they return `{ total,
 * pageSize }` and read the page-size query param as `pageSize`. Left unmapped
 * the count came back `undefined` and the requested page size was ignored
 * (stuck at the controller default). This typed envelope + `toAdminEnvelope`
 * normalize the RBAC shape to the admin contract the FE already consumes.
 */
interface RbacPaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

function toAdminEnvelope<T>(res: RbacPaginatedResponse<T>): PaginatedResponse<T> {
  return { data: res.data, count: res.total, limit: res.pageSize, page: res.page };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const keys = {
  all: ['admin', 'roles'] as const,
  lists: () => [...keys.all, 'list'] as const,
  list: (params?: PaginationParams) => [...keys.lists(), params] as const,
  details: () => [...keys.all, 'detail'] as const,
  detail: (id: string) => [...keys.details(), id] as const,
};

const assignmentKeys = {
  all: ['admin', 'user-role-assignments'] as const,
  byUser: (userId: string) => [...assignmentKeys.all, 'user', userId] as const,
};

function qs(params?: PaginationParams): string {
  if (!params) return '';
  // AC-04 (TASK-336): RBAC reads `pageSize`, not the admin-plane `limit`.
  const mapped: Record<string, unknown> = { page: params.page, pageSize: params.limit, search: params.search };
  const entries = Object.entries(mapped).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// ---------------------------------------------------------------------------
// Role query hooks
// ---------------------------------------------------------------------------

export function useRoles(params?: PaginationParams, options?: Omit<UseQueryOptions<PaginatedResponse<Role>>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.list(params),
    queryFn: async () => toAdminEnvelope(await adminClient.get<RbacPaginatedResponse<Role>>(`/admin/rbac/roles${qs(params)}`)),
    ...options,
  });
}

export function useRole(id: string, options?: Omit<UseQueryOptions<Role>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.detail(id),
    queryFn: () => adminClient.get<Role>(`/admin/rbac/roles/${id}`),
    enabled: !!id,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Role mutation hooks
// ---------------------------------------------------------------------------

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) => adminClient.post<Role>('/admin/rbac/roles', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: UpdateRoleInput & { id: string }) => adminClient.patch<Role>(`/admin/rbac/roles/${id}`, input),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all });
      qc.invalidateQueries({ queryKey: keys.detail(variables.id) });
    },
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<void>(`/admin/rbac/roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all });
    },
  });
}

export { keys as roleKeys, assignmentKeys as userRoleAssignmentKeys };
