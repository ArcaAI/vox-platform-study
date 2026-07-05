'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    getGlobalHarnessPolicy,
    getHarnessPolicy,
    getLiveDocConfig,
    updateGlobalHarnessPolicy,
    updateHarnessPolicy,
    updateLiveDocConfig,
} from './client';
import { harnessPolicyKeys } from './keys';
import type { UpdateHarnessPolicyRequest, UpdateLiveDocEngineConfigRequest } from './types';

export function useHarnessPolicy() {
    return useQuery({ queryKey: harnessPolicyKeys.policy(), queryFn: getHarnessPolicy });
}

/** Global-default row — gateway asserts global admin; only mount when elevated. */
export function useGlobalHarnessPolicy(enabled: boolean) {
    return useQuery({ queryKey: harnessPolicyKeys.globalPolicy(), queryFn: getGlobalHarnessPolicy, enabled });
}

export function useLiveDocConfig(enabled: boolean) {
    return useQuery({ queryKey: harnessPolicyKeys.liveConfig(), queryFn: getLiveDocConfig, enabled });
}

export function useUpdateHarnessPolicy() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ patch, etag }: { patch: UpdateHarnessPolicyRequest; etag: string | null }) => updateHarnessPolicy(patch, etag),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: harnessPolicyKeys.policy() }),
    });
}

export function useUpdateGlobalHarnessPolicy() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ patch, etag }: { patch: UpdateHarnessPolicyRequest; etag: string | null }) => updateGlobalHarnessPolicy(patch, etag),
        // A global-default edit also moves the tenant's effective fallback.
        onSuccess: () => queryClient.invalidateQueries({ queryKey: harnessPolicyKeys.root }),
    });
}

export function useUpdateLiveDocConfig() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: UpdateLiveDocEngineConfigRequest) => updateLiveDocConfig(body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: harnessPolicyKeys.liveConfig() }),
    });
}
