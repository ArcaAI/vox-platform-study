'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEffectiveFeatures, getFeatureMatrix, getRegistrySetting, getSettingsCatalog, putFeatureMatrix, putRegistrySetting, resetRegistrySetting } from './client';
import { settingsRegistryKeys } from './keys';
import type { FeatureMatrixWrite, SettingScope } from './types';

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

/**
 * Reset one tenant override. Invalidates BOTH scopes of the key like a write
 * does: dropping the tenant row changes what that tenant resolves, and the
 * platform read is the value it now inherits.
 */
export function useResetRegistrySetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key }: { key: string }) => resetRegistrySetting(key),
    onSuccess: (_result, variables) => queryClient.invalidateQueries({ queryKey: [...settingsRegistryKeys.root, 'setting', variables.key] }),
  });
}

/**
 * The caller's feature gates. Cached for the session: they change only when a
 * platform admin edits the matrix, and that mutation invalidates them.
 */
export function useEffectiveFeatures(enabled = true) {
  return useQuery({
    queryKey: settingsRegistryKeys.featuresEffective(),
    queryFn: () => getEffectiveFeatures(),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

/** The cross-tenant matrix. 403 for a non-platform-admin, so do not retry it. */
export function useFeatureMatrix(enabled = true) {
  return useQuery({
    queryKey: settingsRegistryKeys.featureMatrix(),
    queryFn: () => getFeatureMatrix(),
    enabled,
    retry: false,
  });
}

/**
 * Save a screenful of matrix edits as ONE batch.
 *
 * Invalidates the effective gates as well as the matrix: a save that hides a
 * console screen must be reflected in the navigation of the session that made
 * it, not on the next reload.
 */
export function usePutFeatureMatrix() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (cells: FeatureMatrixWrite[]) => putFeatureMatrix(cells),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: settingsRegistryKeys.featureMatrix() });
      await queryClient.invalidateQueries({ queryKey: settingsRegistryKeys.featuresEffective() });
    },
  });
}
