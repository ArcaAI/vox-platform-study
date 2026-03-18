/**
 * @arcaai/vox - useGlobalSettings Hook (TASK-032 WS-A)
 *
 * Global settings CRUD hook. RBAC-protected.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import { GLOBAL_SETTINGS_ENDPOINTS } from '../core/constants';
import type { GlobalSetting, CreateGlobalSettingInput, UpdateGlobalSettingInput } from '../types/settings';
import type { PaginationParams } from '../types/common';

export interface UseGlobalSettingsReturn {
  settings: GlobalSetting[];
  tenantConfig: GlobalSetting[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<GlobalSetting[]>;
  getByTenant: (tenantId: string, pagination?: PaginationParams) => Promise<GlobalSetting[]>;
  getTenantConfig: (tenantId: string) => Promise<GlobalSetting[]>;
  get: (id: string) => Promise<GlobalSetting>;
  create: (input: CreateGlobalSettingInput) => Promise<GlobalSetting>;
  update: (id: string, input: UpdateGlobalSettingInput) => Promise<GlobalSetting>;
  remove: (id: string) => Promise<void>;
}

export function useGlobalSettings(): UseGlobalSettingsReturn {
  const { execute, isLoading, error } = useApiOperation('useGlobalSettings');

  const [settings, setSettings] = useState<GlobalSetting[]>([]);
  const [tenantConfig, setTenantConfig] = useState<GlobalSetting[]>([]);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<GlobalSetting[]>('list', async (client) => {
        const raw = await client.get(appendPagination(GLOBAL_SETTINGS_ENDPOINTS.LIST, pagination));
        const items = extractArray<GlobalSetting>(raw);
        setSettings(items);
        return items;
      }),
    [execute],
  );

  const getByTenant = useCallback(
    (tenantId: string, pagination?: PaginationParams) =>
      execute<GlobalSetting[]>('getByTenant', async (client) => {
        const raw = await client.get(appendPagination(GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT(tenantId), pagination));
        return extractArray<GlobalSetting>(raw);
      }),
    [execute],
  );

  const getTenantConfig = useCallback(
    (tenantId: string) =>
      execute<GlobalSetting[]>('getTenantConfig', async (client) => {
        const raw = await client.get(GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG(tenantId));
        const items = extractArray<GlobalSetting>(raw);
        setTenantConfig(items);
        return items;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<GlobalSetting>('get', (client) => client.get<GlobalSetting>(GLOBAL_SETTINGS_ENDPOINTS.GET(id))),
    [execute],
  );

  const create = useCallback(
    (input: CreateGlobalSettingInput) =>
      execute<GlobalSetting>('create', async (client) => {
        const data = await client.post<GlobalSetting>(GLOBAL_SETTINGS_ENDPOINTS.CREATE, input);
        setSettings((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, input: UpdateGlobalSettingInput) =>
      execute<GlobalSetting>('update', async (client) => {
        const data = await client.patch<GlobalSetting>(GLOBAL_SETTINGS_ENDPOINTS.UPDATE(id), input);
        setSettings((prev) => prev.map((s) => (s.id === id ? data : s)));
        return data;
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(GLOBAL_SETTINGS_ENDPOINTS.DELETE(id));
        setSettings((prev) => prev.filter((s) => s.id !== id));
      }),
    [execute],
  );

  return { settings, tenantConfig, isLoading, error, list, getByTenant, getTenantConfig, get, create, update, remove };
}
