'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ListParams } from '@/shared/api';
import type { UpdateTenantConfigItem } from '@/features/tenants/api/types';
import type { UpdateUserSettingRequest } from '@/features/users/api/types';
import {
    getMyEntitlements,
    getMyPreferences,
    getMyTenant,
    listMySettings,
    listMyTenantConfigs,
    updateMyPreferences,
    updateMySetting,
    updateMyTenantConfigs,
} from './client';
import { accountKeys } from './keys';
import type { UpdateUserPreferencesRequest } from './types';

export function useMyTenant() {
    return useQuery({ queryKey: accountKeys.tenant(), queryFn: getMyTenant });
}

export function useMyTenantConfigs(params?: ListParams) {
    return useQuery({ queryKey: accountKeys.tenantConfigs(params), queryFn: () => listMyTenantConfigs(params), placeholderData: keepPreviousData });
}

export function useMyEntitlements() {
    return useQuery({ queryKey: accountKeys.entitlements(), queryFn: getMyEntitlements });
}

export function useMySettings() {
    return useQuery({ queryKey: accountKeys.settings(), queryFn: listMySettings });
}

export function useMyPreferences() {
    return useQuery({ queryKey: accountKeys.preferences(), queryFn: getMyPreferences });
}

function useInvalidateAccount() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: accountKeys.root });
}

export function useUpdateMyTenantConfigs() {
    const invalidate = useInvalidateAccount();
    return useMutation({
        mutationFn: ({ updates, etag }: { updates: UpdateTenantConfigItem[]; etag: string }) => updateMyTenantConfigs(updates, etag),
        onSuccess: invalidate,
    });
}

export function useUpdateMySetting() {
    const invalidate = useInvalidateAccount();
    return useMutation({
        mutationFn: ({ namespace, key, body }: { namespace: string; key: string; body: UpdateUserSettingRequest }) => updateMySetting(namespace, key, body),
        onSuccess: invalidate,
    });
}

export function useUpdateMyPreferences() {
    const invalidate = useInvalidateAccount();
    return useMutation({ mutationFn: (body: UpdateUserPreferencesRequest) => updateMyPreferences(body), onSuccess: invalidate });
}
