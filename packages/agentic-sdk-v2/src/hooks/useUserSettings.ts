/**
 * @arcaai/vox - useUserSettings Hook (TASK-032 WS-A)
 *
 * User settings CRUD hook. Separate from PersonalizationManager (lightweight preferences).
 * User settings are RBAC-protected structured configuration records.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import { USER_SETTINGS_ENDPOINTS } from '../core/constants';
import type { UserSetting, CreateUserSettingInput, UpdateUserSettingInput } from '../types/settings';
import type { PaginationParams } from '../types/common';

export interface UseUserSettingsReturn {
  settings: UserSetting[];
  mySettings: UserSetting[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<UserSetting[]>;
  getMySettings: (userId: string) => Promise<UserSetting[]>;
  get: (id: string) => Promise<UserSetting>;
  create: (input: CreateUserSettingInput) => Promise<UserSetting>;
  update: (id: string, input: UpdateUserSettingInput) => Promise<UserSetting>;
}

export function useUserSettings(): UseUserSettingsReturn {
  const { execute, isLoading, error } = useApiOperation('useUserSettings');

  const [settings, setSettings] = useState<UserSetting[]>([]);
  const [mySettings, setMySettings] = useState<UserSetting[]>([]);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<UserSetting[]>('list', async (client) => {
        const raw = await client.get(appendPagination(USER_SETTINGS_ENDPOINTS.LIST, pagination));
        const items = extractArray<UserSetting>(raw);
        setSettings(items);
        return items;
      }),
    [execute],
  );

  const getMySettings = useCallback(
    (userId: string) =>
      execute<UserSetting[]>('getMySettings', async (client) => {
        const raw = await client.get(USER_SETTINGS_ENDPOINTS.MY_SETTINGS(userId));
        const items = extractArray<UserSetting>(raw);
        setMySettings(items);
        return items;
      }),
    [execute],
  );

  const get = useCallback(
    (id: string) =>
      execute<UserSetting>('get', (client) =>
        client.get<UserSetting>(USER_SETTINGS_ENDPOINTS.GET(id)),
      ),
    [execute],
  );

  const create = useCallback(
    (input: CreateUserSettingInput) =>
      execute<UserSetting>('create', async (client) => {
        const payload = {
          ...input,
          name: input.name || input.key,
          value: typeof input.value === 'string' ? input.value : JSON.stringify(input.value),
          dataType: input.dataType || (typeof input.value === 'object' ? 'Json' : 'String'),
        };
        const data = await client.post<UserSetting>(USER_SETTINGS_ENDPOINTS.CREATE, payload);
        setSettings((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  const update = useCallback(
    (id: string, input: UpdateUserSettingInput) =>
      execute<UserSetting>('update', async (client) => {
        const data = await client.patch<UserSetting>(USER_SETTINGS_ENDPOINTS.UPDATE(id), input);
        setSettings((prev) => prev.map((s) => (s.id === id ? data : s)));
        return data;
      }),
    [execute],
  );

  return {
    settings,
    mySettings,
    isLoading,
    error,
    list,
    getMySettings,
    get,
    create,
    update,
  };
}
