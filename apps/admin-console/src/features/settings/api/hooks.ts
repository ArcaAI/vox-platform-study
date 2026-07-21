'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import { createGlobalSetting, deleteGlobalSetting, getGlobalSetting, listGlobalSettings, listSettingHistory, listTenantScopedSettings, revealGlobalSetting, rotateGlobalSetting, updateGlobalSetting } from './client';
import { settingKeys } from './keys';
import type { CreateGlobalSettingRequest, RotateGlobalSettingRequest, UpdateGlobalSettingRequest } from './types';

export function useGlobalSettings(params?: ListParams) {
    return useQuery({ queryKey: settingKeys.list(params), queryFn: () => listGlobalSettings(params), placeholderData: keepPreviousData });
}

export function useTenantScopedSettings(tenantId: string, params?: ListParams) {
    return useQuery({
        queryKey: settingKeys.byTenant(tenantId, params),
        queryFn: () => listTenantScopedSettings(tenantId, params),
        enabled: !!tenantId,
        placeholderData: keepPreviousData,
    });
}

export function useGlobalSetting(id: string) {
    return useQuery({ queryKey: settingKeys.detail(id), queryFn: () => getGlobalSetting(id), enabled: !!id });
}

/** Wide-page catalog read backing {@link useSettingNamespaces} (values arrive masked for secrets). */
const NAMESPACE_CATALOG_PARAMS: ListParams = { limit: 500 };

/**
 * Distinct namespaces for the Namespace filter chip. There is no
 * dedicated distinct endpoint, so this derives the catalog from one wide,
 * cached page of the list (same tradeoff as the tenant catalog); the screen
 * merges in any URL-selected values so persisted filters always render.
 */
export function useSettingNamespaces() {
    return useQuery({
        queryKey: settingKeys.namespaces(),
        queryFn: () => listGlobalSettings(NAMESPACE_CATALOG_PARAMS),
        staleTime: 60_000,
        select: (envelope) => {
            const namespaces = new Set<string>();
            for (const row of envelope.data ?? []) {
                if (row.namespace) namespaces.add(row.namespace);
            }
            return [...namespaces].sort((a, b) => a.localeCompare(b));
        },
    });
}

/** Audit-log-backed change history for the drawer's History tab (opt-in via `enabled`). */
export function useSettingHistory(id: string, enabled = true) {
    return useQuery({ queryKey: settingKeys.history(id), queryFn: () => listSettingHistory(id), enabled: enabled && !!id });
}

function useInvalidateSettings() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: settingKeys.root });
}

export function useCreateGlobalSetting() {
    const invalidate = useInvalidateSettings();
    return useMutation({ mutationFn: (body: CreateGlobalSettingRequest) => createGlobalSetting(body), onSuccess: invalidate });
}

export function useUpdateGlobalSetting() {
    const invalidate = useInvalidateSettings();
    return useMutation({
        mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateGlobalSettingRequest; etag: string }) => updateGlobalSetting(id, patch, etag),
        onSuccess: invalidate,
    });
}

export function useDeleteGlobalSetting() {
    const invalidate = useInvalidateSettings();
    return useMutation({ mutationFn: (id: string) => deleteGlobalSetting(id), onSuccess: invalidate });
}

/** Reveal result is deliberately NOT cached — it holds a plaintext secret. */
export function useRevealGlobalSetting() {
    return useMutation({ mutationFn: ({ id, password }: { id: string; password: string }) => revealGlobalSetting(id, password) });
}

/**
 * Server-side secret rotation (step-up + OCC). The response is the
 * MASKED setting (never the plaintext), so invalidating the settings caches is
 * safe and propagates the new version/ETag to the drawer.
 */
export function useRotateGlobalSetting() {
    const invalidate = useInvalidateSettings();
    return useMutation({
        mutationFn: ({ id, body, etag }: { id: string; body: RotateGlobalSettingRequest; etag: string }) => rotateGlobalSetting(id, body, etag),
        onSuccess: invalidate,
    });
}
