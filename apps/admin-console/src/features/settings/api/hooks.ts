'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import { createGlobalSetting, deleteGlobalSetting, getGlobalSetting, listGlobalSettings, listSettingHistory, listTenantScopedSettings, revealGlobalSetting, updateGlobalSetting } from './client';
import { settingKeys } from './keys';
import type { CreateGlobalSettingRequest, UpdateGlobalSettingRequest } from './types';

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
