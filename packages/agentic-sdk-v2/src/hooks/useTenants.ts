/**
 * @arcaai/vox - useTenants Hook
 *
 * Tenant management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { TENANT_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import type { PaginationParams } from '../types/common';

/** Commercial plan tiers. Nullable on existing rows. */
export type TenantPlan = 'ENTERPRISE' | 'PRO' | 'TRIAL' | 'STARTER';

export interface Tenant {
  id: string;
  name: string;
  key?: string;
  description?: string;
  resourceStatus?: string;
  // Commercial plan + free-form tags.
  plan?: TenantPlan | null;
  tags?: string[];
  [key: string]: unknown;
}

export interface CreateTenantInput {
  name: string;
  key?: string;
  description?: string;
  plan?: TenantPlan;
  tags?: string[];
  [key: string]: unknown;
}

export interface UpdateTenantInput {
  name?: string;
  description?: string;
  resourceStatus?: string;
  plan?: TenantPlan;
  [key: string]: unknown;
}

/**
 * Tenant usage roll-up returned by `GET /admin/tenants/:id/usage`.
 * Inventory counts + Postgres-derived storage (#5) and clinical (#16) figures.
 * `storageQuotaBytes` is `null` until a `TenantBucket.quotaBytes` is set.
 */
export interface TenantUsageStats {
  totalUsers: number;
  totalDepartments: number;
  totalPromptTemplates: number;
  totalPipelines: number;
  storageUsedBytes: number;
  storageQuotaBytes: number | null;
  transcriptionMinutes: number;
  summaries24h: number;
  totalConsultations: number;
}

export interface UseTenantsReturn {
  tenants: Tenant[];
  currentTenant: Tenant | null;
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<Tenant[]>;
  get: (id: string) => Promise<Tenant>;
  getByCodeName: (codeName: string) => Promise<Tenant>;
  create: (input: CreateTenantInput) => Promise<Tenant>;
  update: (id: string, input: UpdateTenantInput) => Promise<Tenant>;
  remove: (id: string) => Promise<void>;
  enable: (id: string) => Promise<Tenant>;
  disable: (id: string) => Promise<Tenant>;
  // Operator lifecycle transitions.
  suspend: (id: string) => Promise<Tenant>;
  archive: (id: string) => Promise<Tenant>;
  restore: (id: string) => Promise<Tenant>;
  // Tenant tags read/set.
  getTags: (id: string) => Promise<string[]>;
  setTags: (id: string, tags: string[]) => Promise<Tenant>;
  getConfigs: (identifier: string) => Promise<unknown>;
  updateConfigs: (identifier: string, data: unknown) => Promise<unknown>;
  getUsage: (id: string) => Promise<TenantUsageStats>;
}

export function useTenants(): UseTenantsReturn {
  const { execute, isLoading, error } = useApiOperation('useTenants');

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [currentTenant, setCurrentTenant] = useState<Tenant | null>(null);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<Tenant[]>('list', async (client) => {
        const raw = await client.get(appendPagination(TENANT_ENDPOINTS.LIST, pagination));
        const result = extractArray<Tenant>(raw);
        setTenants(result);
        return result;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<Tenant>('get', async (client) => {
        const data = await client.get<Tenant>(TENANT_ENDPOINTS.GET(id));
        setCurrentTenant(data);
        return data;
      }),
    [execute],
  );

  const getByCodeName = useCallback(
    (codeName: string) =>
      execute<Tenant>('getByCodeName', async (client) => {
        const data = await client.get<Tenant>(TENANT_ENDPOINTS.GET_BY_CODE_NAME(codeName));
        setCurrentTenant(data);
        return data;
      }),
    [execute],
  );

  const create = useCallback(
    (input: CreateTenantInput) =>
      execute<Tenant>('create', async (client) => {
        const data = await client.post<Tenant>(TENANT_ENDPOINTS.CREATE, input);
        setTenants((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, input: UpdateTenantInput) =>
      execute<Tenant>('update', async (client) => {
        // OCC: `PATCH admin/tenants/:id` is
        // `@RequiresIfMatch()`, so a plain PATCH is rejected `428 Precondition
        // Required`. Read the row's current `ETag` and replay it as the strong
        // `If-Match` validator — the canonical getWithEtag→patchWithIfMatch OCC
        // flow (see `useGlobalSettings`); the server CAS-checks it (`412` on
        // drift). Fall back to a plain PATCH only if the response carries no
        // `ETag` (non-versioned resource), which keeps the call working rather
        // than hard-failing.
        const { etag } = await client.getWithEtag<Tenant>(TENANT_ENDPOINTS.GET(id));
        const updated = etag
          ? await client.patchWithIfMatch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), input, etag)
          : await client.patch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), input);
        setCurrentTenant(updated);
        setTenants((prev) => prev.map((t) => (t.id === id ? updated : t)));
        return updated;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(TENANT_ENDPOINTS.DELETE(id));
        setTenants((prev) => prev.filter((t) => t.id !== id));
      }),
    [execute],
  );

  const enable = useCallback(
    (id: string) =>
      execute<Tenant>('enable', async (client) => {
        const updated = await client.patch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), { resourceStatus: 'ENABLED' });
        const raw = await client.get(TENANT_ENDPOINTS.LIST);
        setTenants(extractArray<Tenant>(raw));
        setCurrentTenant(updated);
        return updated;
      }),
    [execute],
  );

  const disable = useCallback(
    (id: string) =>
      execute<Tenant>('disable', async (client) => {
        const updated = await client.patch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), { resourceStatus: 'DISABLED' });
        const raw = await client.get(TENANT_ENDPOINTS.LIST);
        setTenants(extractArray<Tenant>(raw));
        setCurrentTenant(updated);
        return updated;
      }),
    [execute],
  );

  // Lifecycle transitions. POST (non-OCC) operator
  // actions; the server refreshes the list + current tenant afterwards.
  const suspend = useCallback(
    (id: string) =>
      execute<Tenant>('suspend', async (client) => {
        const updated = await client.post<Tenant>(TENANT_ENDPOINTS.SUSPEND(id), {});
        setCurrentTenant(updated);
        setTenants((prev) => prev.map((t) => (t.id === id ? updated : t)));
        return updated;
      }),
    [execute],
  );

  const archive = useCallback(
    (id: string) =>
      execute<Tenant>('archive', async (client) => {
        const updated = await client.post<Tenant>(TENANT_ENDPOINTS.ARCHIVE(id), {});
        setCurrentTenant(updated);
        setTenants((prev) => prev.map((t) => (t.id === id ? updated : t)));
        return updated;
      }),
    [execute],
  );

  const restore = useCallback(
    (id: string) =>
      execute<Tenant>('restore', async (client) => {
        const updated = await client.post<Tenant>(TENANT_ENDPOINTS.RESTORE(id), {});
        setCurrentTenant(updated);
        setTenants((prev) => prev.map((t) => (t.id === id ? updated : t)));
        return updated;
      }),
    [execute],
  );

  // Tags read/set. `GET` returns `{ tags }`; `PUT`
  // replaces the full set and returns the updated tenant.
  const getTags = useCallback(
    (id: string) =>
      execute<string[]>('getTags', async (client) => {
        const data = await client.get<{ tags: string[] }>(TENANT_ENDPOINTS.TAGS(id));
        return data?.tags ?? [];
      }),
    [execute],
  );

  const setTags = useCallback(
    (id: string, tags: string[]) =>
      execute<Tenant>('setTags', async (client) => {
        const updated = await client.put<Tenant>(TENANT_ENDPOINTS.TAGS(id), { tags });
        setCurrentTenant(updated);
        setTenants((prev) => prev.map((t) => (t.id === id ? updated : t)));
        return updated;
      }),
    [execute],
  );

  const getConfigs = useCallback(
    (identifier: string) =>
      execute<unknown>('getConfigs', async (client) => {
        return await client.get(TENANT_ENDPOINTS.GET_CONFIGS(identifier));
      }),
    [execute],
  );

  const updateConfigs = useCallback(
    (identifier: string, data: unknown) =>
      execute<unknown>('updateConfigs', async (client) => {
        return await client.patch(TENANT_ENDPOINTS.UPDATE_CONFIGS(identifier), data);
      }),
    [execute],
  );

  const getUsage = useCallback(
    (id: string) => execute<TenantUsageStats>('getUsage', (client) => client.get<TenantUsageStats>(TENANT_ENDPOINTS.USAGE(id))),
    [execute],
  );

  return {
    tenants,
    currentTenant,
    isLoading,
    error,
    list,
    get,
    getByCodeName,
    create,
    update,
    remove,
    enable,
    disable,
    suspend,
    archive,
    restore,
    getTags,
    setTags,
    getConfigs,
    updateConfigs,
    getUsage,
  };
}
