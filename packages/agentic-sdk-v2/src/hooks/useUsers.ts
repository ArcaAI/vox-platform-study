/**
 * @arcaai/vox - useUsers Hook (TASK-032 WS-G, refactored TASK-039)
 *
 * User management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { USER_ENDPOINTS } from '../core/constants';
import { extractArray, extractPaginated } from '../utils/responseUtils';
import { appendPagination, appendFilters } from '../utils/urlUtils';
import type { PaginationParams, PaginatedResponse } from '../types/common';

export interface User {
  id: string;
  username: string;
  email?: string;
  externalId?: string;
  tenantId?: string;
  isServiceAccount?: boolean;
  resourceStatus?: string;
  /** Primary department the user belongs to (G8) */
  primaryDepartmentId?: string;
  /** All department IDs the user is associated with (G8) */
  departmentIds?: string[];
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

export interface AssignDepartmentsInput {
  primaryDepartmentId?: string;
  departmentIds: string[];
}

export interface SearchUsersOptions {
  limit?: number;
}

export interface UseUsersReturn {
  users: User[];
  currentUser: User | null;
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<User[]>;
  listPaginated: (pagination?: PaginationParams) => Promise<PaginatedResponse<User>>;
  search: (query: string, options?: SearchUsersOptions) => Promise<User[]>;
  get: (id: string) => Promise<User>;
  getByExternalId: (externalId: string) => Promise<User>;
  create: (input: CreateUserInput) => Promise<User>;
  update: (id: string, input: UpdateUserInput) => Promise<User>;
  remove: (id: string) => Promise<void>;
  enable: (id: string) => Promise<User>;
  disable: (id: string) => Promise<User>;
  assignDepartments: (userId: string, input: AssignDepartmentsInput) => Promise<User>;
}

export function useUsers(): UseUsersReturn {
  const { execute, isLoading, error } = useApiOperation('useUsers');

  const [users, setUsers] = useState<User[]>([]);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<User[]>('list', async (client) => {
        const raw = await client.get(appendPagination(USER_ENDPOINTS.LIST, pagination));
        const result = extractArray<User>(raw);
        setUsers(result);
        return result;
      }),
    [execute],
  );

  const listPaginated = useCallback(
    (pagination?: PaginationParams) =>
      execute<PaginatedResponse<User>>('listPaginated', async (client) => {
        const raw = await client.get(appendPagination(USER_ENDPOINTS.LIST, pagination));
        const result = extractPaginated<User>(raw);
        setUsers(result.data);
        return result;
      }),
    [execute],
  );

  const search = useCallback(
    (query: string, options?: SearchUsersOptions) =>
      execute<User[]>('search', async (client) => {
        const url = appendFilters(USER_ENDPOINTS.SEARCH, {
          search: query,
          limit: options?.limit !== undefined ? String(options.limit) : undefined,
        });
        const raw = await client.get(url);
        return extractArray<User>(raw);
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<User>('get', async (client) => {
        const data = await client.get<User>(USER_ENDPOINTS.GET(id));
        setCurrentUser(data);
        return data;
      }),
    [execute],
  );

  const getByExternalId = useCallback(
    (externalId: string) =>
      execute<User>('getByExternalId', async (client) => {
        const data = await client.get<User>(USER_ENDPOINTS.GET_BY_EXTERNAL(externalId));
        setCurrentUser(data);
        return data;
      }),
    [execute],
  );

  const create = useCallback(
    (input: CreateUserInput) =>
      execute<User>('create', async (client) => {
        const data = await client.post<User>(USER_ENDPOINTS.CREATE, input);
        setUsers((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, input: UpdateUserInput) =>
      execute<User>('update', async (client) => {
        const updated = await client.patch<User>(USER_ENDPOINTS.UPDATE(id), input);
        setCurrentUser(updated);
        setUsers((prev) => prev.map((u) => (u.id === id ? updated : u)));
        return updated;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(USER_ENDPOINTS.DELETE(id));
        setUsers((prev) => prev.filter((u) => u.id !== id));
      }),
    [execute],
  );

  const enable = useCallback(
    (id: string) => update(id, { resourceStatus: 'ENABLED' }),
    [update],
  );

  const disable = useCallback(
    (id: string) => update(id, { resourceStatus: 'DISABLED' }),
    [update],
  );

  const assignDepartments = useCallback(
    (userId: string, input: AssignDepartmentsInput) =>
      execute<User>('assignDepartments', async (client) => {
        const updated = await client.patch<User>(
          `${USER_ENDPOINTS.UPDATE(userId)}/departments`,
          input
        );
        setCurrentUser(updated);
        setUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)));
        return updated;
      }),
    [execute],
  );

  return {
    users, currentUser, isLoading, error,
    list, listPaginated, search, get, getByExternalId, create, update, remove, enable, disable,
    assignDepartments,
  };
}
