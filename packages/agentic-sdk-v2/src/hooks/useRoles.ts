/**
 * @arcaai/vox - useRoles Hook (TASK-032 WS-G, refactored TASK-039)
 *
 * Role management and user-role assignment hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { ROLE_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';

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
  listRoles: () => Promise<Role[]>;
  getRole: (id: string) => Promise<Role>;
  createRole: (input: CreateRoleInput) => Promise<Role>;
  updateRole: (id: string, input: UpdateRoleInput) => Promise<Role>;
  deleteRole: (id: string) => Promise<void>;
  assignPolicy: (roleId: string, policyId: string, priority?: number) => Promise<unknown>;
  removePolicy: (roleId: string, policyId: string) => Promise<void>;
  getUserRoles: (userId: string) => Promise<UserRoleAssignment[]>;
  assignRole: (userId: string, roleId: string, tenantId?: string) => Promise<UserRoleAssignment>;
  removeRole: (userId: string, roleId: string) => Promise<void>;
}

export function useRoles(): UseRolesReturn {
  const { execute, isLoading, error } = useApiOperation('useRoles');
  const [roles, setRoles] = useState<Role[]>([]);

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
    (id: string) =>
      execute<void>('deleteRole', async (client) => {
        await client.delete(ROLE_ENDPOINTS.DELETE(id));
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
    (roleId: string, policyId: string) =>
      execute<void>('removePolicy', (client) => client.delete(ROLE_ENDPOINTS.REMOVE_POLICY(roleId, policyId)) as Promise<void>),
    [execute],
  );

  const getUserRoles = useCallback(
    (userId: string) =>
      execute<UserRoleAssignment[]>('getUserRoles', async (client) => {
        const raw = await client.get(ROLE_ENDPOINTS.USER_ROLES(userId));
        return extractArray<UserRoleAssignment>(raw);
      }),
    [execute],
  );

  const assignRole = useCallback(
    (userId: string, roleId: string, tenantId?: string) =>
      execute<UserRoleAssignment>('assignRole', (client) =>
        client.post<UserRoleAssignment>(ROLE_ENDPOINTS.USER_ROLES(userId), tenantId ? { roleId, tenantId } : { roleId }),
      ),
    [execute],
  );

  const removeRole = useCallback(
    (userId: string, roleId: string) =>
      execute<void>('removeRole', (client) => client.delete(ROLE_ENDPOINTS.USER_ROLE(userId, roleId)) as Promise<void>),
    [execute],
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
    getUserRoles,
    assignRole,
    removeRole,
  };
}
