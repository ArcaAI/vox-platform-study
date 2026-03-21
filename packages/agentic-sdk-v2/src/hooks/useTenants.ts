/**
 * @arcaai/vox - useTenants Hook (TASK-218 Priority 2)
 *
 * Tenant management hook for admin operations.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { TENANT_ENDPOINTS } from '../core/constants';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import type { PaginationParams } from '../types/common';

export interface Tenant {
  id: string;
  name: string;
  key?: string;
  description?: string;
  resourceStatus?: string;
  [key: string]: unknown;
}

export interface CreateTenantInput {
  name: string;
  key?: string;
  description?: string;
  [key: string]: unknown;
}

export interface UpdateTenantInput {
  name?: string;
  description?: string;
  resourceStatus?: string;
  [key: string]: unknown;
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
  getConfigs: (identifier: string) => Promise<unknown>;
  updateConfigs: (identifier: string, data: unknown) => Promise<unknown>;
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
        const updated = await client.patch<Tenant>(TENANT_ENDPOINTS.UPDATE(id), input);
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
    getConfigs,
    updateConfigs,
  };
}
