'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    getGlobalAgenticPolicy,
    getLiveEngineConfig,
    getSettingsCatalog,
    updateGlobalAgenticPolicy,
    updateLiveEngineConfig,
} from './client';
import { agenticPolicyKeys } from './keys';
import type { UpdateAgenticPolicyRequest, UpdateLiveDocEngineConfigRequest } from './types';

/** Global-default row — gateway asserts global admin; only mount when elevated. */
export function useGlobalAgenticPolicy(enabled: boolean) {
    return useQuery({ queryKey: agenticPolicyKeys.globalPolicy(), queryFn: getGlobalAgenticPolicy, enabled });
}

export function useLiveEngineConfig(enabled: boolean) {
    return useQuery({ queryKey: agenticPolicyKeys.liveConfig(), queryFn: getLiveEngineConfig, enabled });
}

export function useSettingsCatalog(enabled: boolean) {
    return useQuery({ queryKey: agenticPolicyKeys.catalog(), queryFn: getSettingsCatalog, enabled });
}

export function useUpdateGlobalAgenticPolicy() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ patch, etag }: { patch: UpdateAgenticPolicyRequest; etag: string | null }) => updateGlobalAgenticPolicy(patch, etag),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: agenticPolicyKeys.globalPolicy() }),
    });
}

export function useUpdateLiveEngineConfig() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: UpdateLiveDocEngineConfigRequest) => updateLiveEngineConfig(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: agenticPolicyKeys.liveConfig() }),
    });
}
