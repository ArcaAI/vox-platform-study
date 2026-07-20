/**
 * @arcaai/vox - useUsers Hook (TASK-032 WS-G, refactored TASK-039)
 *
 * User management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { USER_ENDPOINTS, AUTH_ENDPOINTS } from '../core/constants';
import { extractArray, extractPaginated } from '../utils/responseUtils';
import { appendPagination, appendFilters } from '../utils/urlUtils';
import type { PaginationParams, PaginatedResponse } from '../types/common';
import type { AdminImpersonateOptions, ImpersonateResponse } from '../types/auth';

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

/** TASK-388 #8 — admin reset-password. */
export type ResetPasswordMode = 'temporary' | 'link';

export interface ResetPasswordInput {
  /** `temporary` sets a temp password; `link` (default) mints an emailed reset link. */
  mode?: ResetPasswordMode;
  /** Explicit temporary password (mode=temporary). Generated server-side when omitted. */
  temporaryPassword?: string;
}

export interface ResetPasswordResult {
  mode: ResetPasswordMode;
  /** Present for mode=temporary — convey out-of-band. */
  temporaryPassword?: string;
  /** Present for mode=link. */
  token?: string;
  resetPath?: string;
  expiresInSeconds?: number;
  emailSent?: boolean;
}

export interface CompletePasswordResetInput {
  token: string;
  newPassword: string;
}

export interface CompletePasswordResetResult {
  success: boolean;
}

/** TASK-400 — public self-service forgot-password (anti-enumeration: always the same ack). */
export interface RequestPasswordResetInput {
  email: string;
}

export interface RequestPasswordResetResult {
  success: boolean;
  message: string;
}

/** TASK-388 #9 — server-side bulk user actions (+ TASK-398 `assign-role`). */
export type BulkUserActionType = 'enable' | 'disable' | 'delete' | 'assign-departments' | 'assign-role';

export interface BulkUserActionInput {
  action: BulkUserActionType;
  ids: string[];
  /** Required for action=assign-departments. */
  departmentIds?: string[];
  primaryDepartmentId?: string;
  /** Required for action=assign-role (TASK-398). */
  roleId?: string;
}

export interface BulkUserActionItemResult {
  id: string;
  success: boolean;
  error?: string;
}

export interface BulkUserActionResult {
  action: string;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkUserActionItemResult[];
}

/** TASK-388 #10 — server-side export. */
export type UserExportFormat = 'csv' | 'xlsx' | 'pdf';

export interface UserExportQuery {
  format: UserExportFormat;
  search?: string;
  filters?: string;
  sort?: string;
  searchFields?: string;
}

/**
 * TASK-375 client follow-up — full list query for {@link UseUsersReturn.listPaginated}.
 * Extends the page/limit {@link PaginationParams} with the backend `PaginatedQuery`
 * server-side params, mirroring `AuditLogFilterParams` and the `@arcaai/ui`
 * `toPaginatedQuery` CSV contract:
 *
 * - `search` — free-text search term.
 * - `filters` — comma-separated `field:value` pairs (e.g. `resourceStatus:ENABLED,isServiceAccount:false`).
 * - `sort` — comma-separated `field:asc|desc` rules (e.g. `username:asc,createdAt:desc`).
 * - `searchFields` — comma-separated fields the `search` term applies to.
 *
 * Every field is optional, so callers passing only `page`/`limit` (or nothing)
 * are fully back-compatible.
 */
export interface UserListQuery extends PaginationParams {
  search?: string;
  filters?: string;
  sort?: string;
  searchFields?: string;
}

export interface UseUsersReturn {
  users: User[];
  currentUser: User | null;
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<User[]>;
  listPaginated: (query?: UserListQuery) => Promise<PaginatedResponse<User>>;
  search: (query: string, options?: SearchUsersOptions) => Promise<User[]>;
  get: (id: string) => Promise<User>;
  getByExternalId: (externalId: string) => Promise<User>;
  create: (input: CreateUserInput) => Promise<User>;
  update: (id: string, input: UpdateUserInput) => Promise<User>;
  remove: (id: string) => Promise<void>;
  enable: (id: string) => Promise<User>;
  disable: (id: string) => Promise<User>;
  assignDepartments: (userId: string, input: AssignDepartmentsInput) => Promise<User>;
  /** TASK-388 #8 — admin reset-password (temporary password OR emailed link). */
  resetPassword: (userId: string, input?: ResetPasswordInput) => Promise<ResetPasswordResult>;
  /** TASK-388 #8 — public completion of a reset link (token-carried). */
  completePasswordReset: (input: CompletePasswordResetInput) => Promise<CompletePasswordResetResult>;
  /** TASK-400 — public self-service forgot-password (always resolves with the generic ack). */
  requestPasswordReset: (input: RequestPasswordResetInput) => Promise<RequestPasswordResetResult>;
  /**
   * TASK-401 — global-admin-only time-boxed impersonation mint ("act as").
   * Returns the target session payload (token + user + expiry). The CALLER owns
   * the token swap (e.g. the admin app's auth store) — unlike
   * `useAuth().impersonate()`, nothing is stashed inside the SDK client here.
   */
  impersonate: (userId: string, options?: AdminImpersonateOptions) => Promise<ImpersonateResponse>;
  /**
   * TASK-401 — end an active impersonation early: revokes the impersonation
   * token's jti server-side (audited). Must be called while the client still
   * sends the impersonation token; the caller then restores its original session.
   */
  endImpersonation: () => Promise<{ success: boolean }>;
  /** TASK-388 #9 — server-side bulk action with per-item results. */
  bulkAction: (input: BulkUserActionInput) => Promise<BulkUserActionResult>;
  /** TASK-388 #10 — server-side export (csv | xlsx | pdf) as a Blob. */
  exportUsers: (query: UserExportQuery) => Promise<Blob>;
}

/** Extract the backend `PaginatedQuery` server-side params (skip page/limit). */
function toListFilterQuery(query?: UserListQuery): Record<string, string | undefined> {
  return {
    search: query?.search,
    sort: query?.sort,
    filters: query?.filters,
    searchFields: query?.searchFields,
  };
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
    (query?: UserListQuery) =>
      execute<PaginatedResponse<User>>('listPaginated', async (client) => {
        // Forward the full backend `PaginatedQuery` (CSV filters + sort + search),
        // built like the offset audit-log query: filters first, then page/limit.
        const pagination = query && (query.page !== undefined || query.limit !== undefined) ? { page: query.page, limit: query.limit } : undefined;
        const url = appendPagination(appendFilters(USER_ENDPOINTS.LIST, toListFilterQuery(query)), pagination);
        const raw = await client.get(url);
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

  const enable = useCallback((id: string) => update(id, { resourceStatus: 'ENABLED' }), [update]);

  const disable = useCallback((id: string) => update(id, { resourceStatus: 'DISABLED' }), [update]);

  const assignDepartments = useCallback(
    (userId: string, input: AssignDepartmentsInput) =>
      execute<User>('assignDepartments', async (client) => {
        const updated = await client.patch<User>(`${USER_ENDPOINTS.UPDATE(userId)}/departments`, input);
        setCurrentUser(updated);
        setUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)));
        return updated;
      }),
    [execute],
  );

  // TASK-388 #8 — admin reset-password. `mode=temporary` returns the plaintext to
  // convey out-of-band; `mode=link` (default) returns the token/link (also emailed
  // best-effort). No local state mutation — this is a side-effect action.
  const resetPassword = useCallback(
    (userId: string, input?: ResetPasswordInput) =>
      execute<ResetPasswordResult>('resetPassword', (client) => client.post<ResetPasswordResult>(USER_ENDPOINTS.RESET_PASSWORD(userId), input ?? {})),
    [execute],
  );

  // TASK-388 #8 — public completion; consumes the single-use token to set a new password.
  const completePasswordReset = useCallback(
    (input: CompletePasswordResetInput) =>
      execute<CompletePasswordResetResult>('completePasswordReset', (client) =>
        client.post<CompletePasswordResetResult>(USER_ENDPOINTS.PASSWORD_RESET_COMPLETE, input),
      ),
    [execute],
  );

  // TASK-400 — public forgot-password; the reset link travels ONLY via email.
  const requestPasswordReset = useCallback(
    (input: RequestPasswordResetInput) =>
      execute<RequestPasswordResetResult>('requestPasswordReset', (client) =>
        client.post<RequestPasswordResetResult>(USER_ENDPOINTS.FORGOT_PASSWORD, input),
      ),
    [execute],
  );

  // TASK-401 — global-admin impersonation mint; thin wrapper (token swap is the
  // caller's job) so the admin app can retain its original session for restore.
  const impersonate = useCallback(
    (userId: string, options?: AdminImpersonateOptions) =>
      execute<ImpersonateResponse>('impersonate', (client) => client.post<ImpersonateResponse>(USER_ENDPOINTS.IMPERSONATE(userId), options ?? {})),
    [execute],
  );

  // TASK-401 — early end: server-side jti revocation via the existing
  // /auth/revoke-impersonation route (called with the impersonation token).
  const endImpersonation = useCallback(
    () => execute<{ success: boolean }>('endImpersonation', (client) => client.post<{ success: boolean }>(AUTH_ENDPOINTS.REVOKE_IMPERSONATION, {})),
    [execute],
  );

  // TASK-388 #9 — server-side bulk action (one round-trip, per-item results).
  const bulkAction = useCallback(
    (input: BulkUserActionInput) =>
      execute<BulkUserActionResult>('bulkAction', (client) => client.post<BulkUserActionResult>(USER_ENDPOINTS.BULK_ACTIONS, input)),
    [execute],
  );

  // TASK-388 #10 — server-side export as a Blob (csv | xlsx | pdf). Forwards the
  // same PaginatedQuery CSV filters/sort/search as the list so the export mirrors
  // the on-screen view; the caller triggers the file download.
  const exportUsers = useCallback(
    (query: UserExportQuery) =>
      execute<Blob>('exportUsers', (client) => {
        const url = appendFilters(USER_ENDPOINTS.EXPORT, {
          format: query.format,
          search: query.search,
          filters: query.filters,
          sort: query.sort,
          searchFields: query.searchFields,
        });
        return client.getBlob(url);
      }),
    [execute],
  );

  return {
    users,
    currentUser,
    isLoading,
    error,
    list,
    listPaginated,
    search,
    get,
    getByExternalId,
    create,
    update,
    remove,
    enable,
    disable,
    assignDepartments,
    resetPassword,
    completePasswordReset,
    requestPasswordReset,
    impersonate,
    endImpersonation,
    bulkAction,
    exportUsers,
  };
}
