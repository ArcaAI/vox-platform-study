/**
 * @arcaai/vox - useUserDepartments Hook (TASK-328 A1)
 *
 * Admin hook for managing a user's department assignments. Mirrors the
 * `/admin/users/:id/departments` controller; tenant scoping is carried by the
 * active tenant context on the client (global admins set `X-Tenant-Id`).
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { ADMIN_USER_DEPARTMENTS_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';

export interface UserDepartmentAssignment {
  id: string;
  userId: string;
  departmentId: string;
  isPrimary: boolean;
  tenantId: string;
  version: number;
  [key: string]: unknown;
}

export interface AssignUserDepartmentInput {
  departmentId: string;
  isPrimary?: boolean;
}

export interface UseUserDepartmentsReturn {
  assignments: UserDepartmentAssignment[];
  isLoading: boolean;
  error: Error | null;
  list: (userId: string) => Promise<UserDepartmentAssignment[]>;
  assign: (userId: string, input: AssignUserDepartmentInput) => Promise<UserDepartmentAssignment>;
  setPrimary: (userId: string, assignmentId: string, isPrimary: boolean, version: number) => Promise<UserDepartmentAssignment>;
  unassign: (userId: string, assignmentId: string) => Promise<void>;
}

export function useUserDepartments(): UseUserDepartmentsReturn {
  const { execute, isLoading, error } = useApiOperation('useUserDepartments');

  const [assignments, setAssignments] = useState<UserDepartmentAssignment[]>([]);

  const list = useCallback(
    (userId: string) =>
      execute<UserDepartmentAssignment[]>('list', async (client) => {
        const raw = await client.get(ADMIN_USER_DEPARTMENTS_ENDPOINTS.LIST(userId));
        const items = extractArray<UserDepartmentAssignment>(raw);
        setAssignments(items);
        return items;
      }),
    [execute],
  );

  const assign = useCallback(
    (userId: string, input: AssignUserDepartmentInput) =>
      execute<UserDepartmentAssignment>('assign', async (client) => {
        const created = await client.post<UserDepartmentAssignment>(ADMIN_USER_DEPARTMENTS_ENDPOINTS.ASSIGN(userId), input);
        setAssignments((prev) => [...prev, created]);
        return created;
      }),
    [execute],
  );

  const setPrimary = useCallback(
    (userId: string, assignmentId: string, isPrimary: boolean, version: number) =>
      execute<UserDepartmentAssignment>('setPrimary', async (client) => {
        // OCC: echo the read version as a strong `If-Match` validator. The
        // controller folds the header over the body-field `expectedVersion`.
        const updated = await client.patchWithIfMatch<UserDepartmentAssignment>(
          ADMIN_USER_DEPARTMENTS_ENDPOINTS.UPDATE(userId, assignmentId),
          { isPrimary, expectedVersion: version },
          `"${version}"`,
        );
        setAssignments((prev) =>
          prev.map((a) => {
            if (a.id === assignmentId) return updated;
            // Reflect the single-primary invariant client-side.
            return isPrimary ? { ...a, isPrimary: false } : a;
          }),
        );
        return updated;
      }),
    [execute],
  );

  const unassign = useCallback(
    (userId: string, assignmentId: string) =>
      execute<void>('unassign', async (client) => {
        await client.delete(ADMIN_USER_DEPARTMENTS_ENDPOINTS.REMOVE(userId, assignmentId));
        setAssignments((prev) => prev.filter((a) => a.id !== assignmentId));
      }),
    [execute],
  );

  return {
    assignments,
    isLoading,
    error,
    list,
    assign,
    setPrimary,
    unassign,
  };
}
