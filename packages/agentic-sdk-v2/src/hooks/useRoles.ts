/**
 * @arcaai/vox - useRoles Hook
 *
 * Role management and user-role assignment hook for admin operations.
 *
 * User-role assignment uses the canonical admin path.
 * The pre-existing `getUserRoles` / `assignRole` / `removeRole` API surface
 * is kept as deprecated aliases that delegate to the new methods, with a
 * one-time `console.warn` per hook instance. The aliases will be removed in
 * a future major; consumers should migrate to `listUserRoleAssignments`,
 * `assignRoleToUser`, and `removeUserRoleAssignment`.
 */

import { useCallback, useRef, useState } from 'react';
import { useApiOperation } from './useApiOperation';
import { ADMIN_USER_ROLES_ENDPOINTS, ROLE_ENDPOINTS, USER_ROLES, type UserRole } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import type { BreakGlassCredentials } from './usePolicies';

/**
 * Built-in user role identifiers.
 *
 * Re-exported from `core/constants` so consumers importing the role hook get
 * the canonical typed tuple alongside the API surface.
 */
export { USER_ROLES, type UserRole };

export interface Role {
  id: string;
  name: string;
  description?: string;
  parentRoleId?: string | null;
  childRoles?: Role[];
  [key: string]: unknown;
}

export interface UserRoleAssignment {
  id: string;
  userId: string;
  roleId: string;
  roleName?: string;
  tenantId?: string | null;
  [key: string]: unknown;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  externalName?: string;
  isSystemRole?: boolean;
  parentRoleId?: string;
  [key: string]: unknown;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  externalName?: string;
  parentRoleId?: string | null;
  [key: string]: unknown;
}

export interface UseRolesReturn {
  roles: Role[];
  isLoading: boolean;
  error: Error | null;

  // Role CRUD (admin /admin/rbac/roles)
  listRoles: () => Promise<Role[]>;
  getRole: (id: string) => Promise<Role>;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
  /** Deletion requires break-glass confirmation (confirm the ROLE name). */
  deleteRole: (id: string, breakGlass?: BreakGlassCredentials) => Promise<void>;
  assignPolicy: (roleId: string, policyId: string, priority?: number) => Promise<unknown>;
  /** Detach requires break-glass confirmation (confirm the POLICY name). */
  removePolicy: (roleId: string, policyId: string, breakGlass?: BreakGlassCredentials) => Promise<void>;

  // Admin user-role assignment surface
  // (uses ADMIN_USER_ROLES_ENDPOINTS → /admin/users/:id/roles[/:assignmentId])
  listUserRoleAssignments: (userId: string) => Promise<UserRoleAssignment[]>;
  assignRoleToUser: (userId: string, roleId: string, tenantId?: string) => Promise<UserRoleAssignment>;
  removeUserRoleAssignment: (userId: string, assignmentId: string) => Promise<void>;

  /** @deprecated Use `listUserRoleAssignments` instead. */
  getUserRoles: (userId: string) => Promise<UserRoleAssignment[]>;
  /** @deprecated Use `assignRoleToUser` instead. */
  assignRole: (userId: string, roleId: string, tenantId?: string) => Promise<UserRoleAssignment>;
  /**
   * @deprecated Use `removeUserRoleAssignment` instead. The
   * second argument is `assignmentId` (a join-table row id), NOT a roleId.
   */
  removeRole: (userId: string, assignmentId: string) => Promise<void>;
}

export function useRoles(): UseRolesReturn {
  const { execute, isLoading, error } = useApiOperation('useRoles');
  const [roles, setRoles] = useState<Role[]>([]);

  // Per-hook-instance one-shot deprecation flags. Using `useRef` (not module
  // state) so each tree gets its own warning lifecycle and StrictMode
  // double-mounts behave predictably.
  const getUserRolesWarnedRef = useRef(false);
  const assignRoleWarnedRef = useRef(false);
  const removeRoleWarnedRef = useRef(false);

  const listRoles = useCallback(
    () =>
      execute<Role[]>('listRoles', async (client) => {
        const raw = await client.get(ROLE_ENDPOINTS.LIST);
        const items = extractArray<Role>(raw);
        setRoles(items);
        return items;
      }),
    [execute],
  );

  const getRole = useCallback((id: string) => execute<Role>('getRole', (client) => client.get<Role>(ROLE_ENDPOINTS.GET(id))), [execute]);

  const createRole = useCallback(
    (input: CreateRoleInput) =>
      execute<Role>('createRole', async (client) => {
        const data = await client.post<Role>(ROLE_ENDPOINTS.CREATE, input);
        setRoles((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const updateRole = useCallback(
    (id: string, input: UpdateRoleInput) =>
      execute<Role>('updateRole', async (client) => {
        const updated = await client.put<Role>(ROLE_ENDPOINTS.UPDATE(id), input);
        setRoles((prev) => prev.map((r) => (r.id === id ? updated : r)));
        return updated;
      }),
    [execute],
  );

  const deleteRole = useCallback(
    (id: string, breakGlass?: BreakGlassCredentials) =>
      execute<void>('deleteRole', async (client) => {
        // Conditional arity keeps the legacy wire shape for callers
        // that pass no confirmation (the API then replies 428).
        if (breakGlass) {
          await client.delete(ROLE_ENDPOINTS.DELETE(id), { data: breakGlass });
        } else {
          await client.delete(ROLE_ENDPOINTS.DELETE(id));
        }
        setRoles((prev) => prev.filter((r) => r.id !== id));
      }),
    [execute],
  );

  const assignPolicy = useCallback(
    (roleId: string, policyId: string, priority?: number) =>
      execute<unknown>('assignPolicy', (client) =>
        client.post(ROLE_ENDPOINTS.ASSIGN_POLICY(roleId, policyId), priority !== undefined ? { priority } : {}),
      ),
    [execute],
  );

  const removePolicy = useCallback(
    (roleId: string, policyId: string, breakGlass?: BreakGlassCredentials) =>
      execute<void>(
        'removePolicy',
        (client) =>
          (breakGlass
            ? client.delete(ROLE_ENDPOINTS.REMOVE_POLICY(roleId, policyId), { data: breakGlass })
            : client.delete(ROLE_ENDPOINTS.REMOVE_POLICY(roleId, policyId))) as Promise<void>,
      ),
    [execute],
  );

  // -------------------------------------------------------------------------
  // Admin user-role assignment surface
  // -------------------------------------------------------------------------

  const listUserRoleAssignments = useCallback(
    (userId: string) =>
      execute<UserRoleAssignment[]>('listUserRoleAssignments', async (client) => {
        const raw = await client.get(ADMIN_USER_ROLES_ENDPOINTS.LIST(userId));
        return extractArray<UserRoleAssignment>(raw);
      }),
    [execute],
  );

  const assignRoleToUser = useCallback(
    (userId: string, roleId: string, tenantId?: string) =>
      execute<UserRoleAssignment>('assignRoleToUser', (client) =>
        client.post<UserRoleAssignment>(ADMIN_USER_ROLES_ENDPOINTS.ASSIGN(userId), tenantId ? { roleId, tenantId } : { roleId }),
      ),
    [execute],
  );

  const removeUserRoleAssignment = useCallback(
    (userId: string, assignmentId: string) =>
      execute<void>('removeUserRoleAssignment', (client) => client.delete(ADMIN_USER_ROLES_ENDPOINTS.REMOVE(userId, assignmentId)) as Promise<void>),
    [execute],
  );

  // -------------------------------------------------------------------------
  // Deprecated aliases — delegate to the new methods, warn once per instance.
  // -------------------------------------------------------------------------

  const getUserRoles = useCallback(
    (userId: string) => {
      if (!getUserRolesWarnedRef.current) {
        getUserRolesWarnedRef.current = true;
        console.warn('[useRoles] `getUserRoles` is deprecated; use `listUserRoleAssignments`. (TASK-279)');
      }
      return listUserRoleAssignments(userId);
    },
    [listUserRoleAssignments],
  );

  const assignRole = useCallback(
    (userId: string, roleId: string, tenantId?: string) => {
      if (!assignRoleWarnedRef.current) {
        assignRoleWarnedRef.current = true;
        console.warn('[useRoles] `assignRole` is deprecated; use `assignRoleToUser`. (TASK-279)');
      }
      return assignRoleToUser(userId, roleId, tenantId);
    },
    [assignRoleToUser],
  );

  const removeRole = useCallback(
    (userId: string, assignmentId: string) => {
      if (!removeRoleWarnedRef.current) {
        removeRoleWarnedRef.current = true;
        console.warn(
          '[useRoles] `removeRole` is deprecated; use `removeUserRoleAssignment`. ' +
            'Note: the second argument is `assignmentId`, not `roleId`. (TASK-279)',
        );
      }
      return removeUserRoleAssignment(userId, assignmentId);
    },
    [removeUserRoleAssignment],
  );

  return {
    roles,
    isLoading,
    error,
    listRoles,
    getRole,
    createRole,
    updateRole,
    deleteRole,
    assignPolicy,
    removePolicy,
    listUserRoleAssignments,
    assignRoleToUser,
    removeUserRoleAssignment,
    getUserRoles,
    assignRole,
    removeRole,
  };
}
