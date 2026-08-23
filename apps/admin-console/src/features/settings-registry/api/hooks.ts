'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRegistrySetting, getSettingsCatalog, putRegistrySetting } from './client';
import { settingsRegistryKeys } from './keys';
import type { SettingScope } from './types';

/** The descriptor inventory. Metadata only, so it caches well. */
export function useSettingsCatalog(enabled = true) {
  return useQuery({
    queryKey: settingsRegistryKeys.catalog(),
    queryFn: () => getSettingsCatalog(),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/**
 * One key's value, fetched LAZILY.
 *
 * There is no bulk value read — the registry lane is key-addressed, one request
 * and one ETag per key. Eagerly loading a super admin's 210 descriptors would
 * mean 210 requests to render a list nobody has scrolled yet, so the list shows
 * metadata (which arrives in a single catalog call) and the value is fetched
 * when a key is actually opened.
 */
export function useRegistrySetting(key: string | null, scope: SettingScope, enabled = true) {
  return useQuery({
    queryKey: settingsRegistryKeys.setting(key ?? '', scope),
    queryFn: () => getRegistrySetting(key!, scope),
    enabled: enabled && key !== null,
  });
}

export function usePutRegistrySetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value, scope, etag }: { key: string; value: unknown; scope: SettingScope; etag: string | null }) =>
      putRegistrySetting(key, value, scope, etag),
    // Both scopes of the written key: a `system` write changes what every
    // tenant without an override resolves to, so the `tenant`-scope read of the
    // same key is now stale even though its own row did not move.
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({ queryKey: [...settingsRegistryKeys.root, 'setting', variables.key] }),
  });
}
