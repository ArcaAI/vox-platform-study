/**
 * @arcaai/vox - useUserSettings Hook
 *
 * Reduced surface — the API only implements `GET /users/me/settings` and
 * `PATCH /users/me/settings/:namespace/:key`. Earlier methods (get(id), create,
 * update(id), getMySettings) targeted routes that do not exist and have been
 * removed.
 *
 * Self-only, business plane. The admin-plane `listForUser`/`updateForUser`
 * methods (targeting another user's settings via `/admin/users/:id/settings`)
 * were removed under TASK-890 (OD-F/OD-K) — `@arcaai/vox` carries no
 * management surface; editing another user's settings is
 * `@arcaai/vox-node`'s `hope.admin.*` or the admin console.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import { USER_SETTINGS_ENDPOINTS } from '../core/constants';
import type { UserSetting } from '../types/settings';
import type { PaginationParams } from '../types/common';

export interface UseUserSettingsReturn {
  settings: UserSetting[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<UserSetting[]>;
  updateByKey: (namespace: string, key: string, value: unknown) => Promise<UserSetting>;
}

export function useUserSettings(): UseUserSettingsReturn {
  const { execute, isLoading, error } = useApiOperation('useUserSettings');
  const [settings, setSettings] = useState<UserSetting[]>([]);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<UserSetting[]>('list', async (client) => {
        const raw = await client.get(appendPagination(USER_SETTINGS_ENDPOINTS.list, pagination));
        const items = extractArray<UserSetting>(raw);
        setSettings(items);
        return items;
      }),
    [execute],
  );

  const updateByKey = useCallback(
    (namespace: string, key: string, value: unknown) =>
      execute<UserSetting>('updateByKey', (client) => client.patch<UserSetting>(USER_SETTINGS_ENDPOINTS.updateByKey(namespace, key), { value })),
    [execute],
  );

  return { settings, isLoading, error, list, updateByKey };
}
