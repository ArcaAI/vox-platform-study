/**
 * @arcaai/vox - useUserSettings Hook
 *
 * Reduced surface — the API only implements `GET /users/me/settings` and
 * `PATCH /users/me/settings/:namespace/:key`. Earlier methods (get(id), create,
 * update(id), getMySettings) targeted routes that do not exist and have been
 * removed.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import { USER_SETTINGS_ENDPOINTS, ADMIN_USER_SETTINGS_ENDPOINTS } from '../core/constants';
import type { UserSetting } from '../types/settings';
import type { PaginationParams } from '../types/common';

export interface UseUserSettingsReturn {
  settings: UserSetting[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<UserSetting[]>;
  updateByKey: (namespace: string, key: string, value: unknown) => Promise<UserSetting>;
  // ─── Admin edit ANOTHER user's settings/preferences ───
  // Target a specific `userId` via the pre-existing admin routes
  // (`assertUserInScope`, tenant-scoped). Requires `manage:User`; a future
  // admin FE uses these to view/edit another user's preferences.
  /** GET all settings for a target user (admin). */
  listForUser: (userId: string) => Promise<UserSetting[]>;
  /** PATCH one setting (namespace/key) for a target user (admin). */
  updateForUser: (userId: string, namespace: string, key: string, value: unknown) => Promise<UserSetting>;
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

  // ─── Admin target-user settings/preferences ──────────
  const listForUser = useCallback(
    (userId: string) =>
      execute<UserSetting[]>('listForUser', async (client) => {
        const raw = await client.get(ADMIN_USER_SETTINGS_ENDPOINTS.list(userId));
        const items = extractArray<UserSetting>(raw);
        setSettings(items);
        return items;
      }),
    [execute],
  );

  const updateForUser = useCallback(
    (userId: string, namespace: string, key: string, value: unknown) =>
      execute<UserSetting>('updateForUser', (client) =>
        client.patch<UserSetting>(ADMIN_USER_SETTINGS_ENDPOINTS.updateByKey(userId, namespace, key), { value }),
      ),
    [execute],
  );

  return { settings, isLoading, error, list, updateByKey, listForUser, updateForUser };
}
