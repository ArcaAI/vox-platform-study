'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGlobalAgenticPolicy,
  getLiveEngineConfig,
  getRegistrySetting,
  getSettingsCatalog,
  putRegistrySetting,
  updateGlobalAgenticPolicy,
  updateLiveEngineConfig,
} from './client';
import { agenticPolicyKeys } from './keys';
import type { UpdateAgenticPolicyRequest, UpdateLiveDocEngineConfigRequest } from './types';

/** Global-default row — gateway asserts super admin; only mount when elevated. */
export function useGlobalAgenticPolicy(enabled: boolean) {
  return useQuery({ queryKey: agenticPolicyKeys.globalPolicy(), queryFn: getGlobalAgenticPolicy, enabled });
}

export function useLiveEngineConfig(enabled: boolean) {
  return useQuery({ queryKey: agenticPolicyKeys.liveConfig(), queryFn: getLiveEngineConfig, enabled });
}

export function useSettingsCatalog(enabled: boolean) {
  return useQuery({ queryKey: agenticPolicyKeys.catalog(), queryFn: getSettingsCatalog, enabled });
}

/**
 * One registry setting's effective value + ETag.
 *
 * Kept per-key rather than batched: the gateway's registry lane is key-addressed
 * and each key carries its OWN version, so a batched read would have no single
 * ETag to precondition writes with.
 */
export function useRegistrySetting(key: string, enabled: boolean) {
  return useQuery({
    queryKey: agenticPolicyKeys.registrySetting(key),
    queryFn: () => getRegistrySetting(key),
    enabled,
  });
}

/**
 * Write one registry setting under OCC.
 *
 * Invalidates that key AND the live-engine config, because the loop reports its
 * effective `agentic.context.*` knobs there — leaving it stale would show the
 * admin the pre-edit values right after a successful save.
 */
export function usePutRegistrySetting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value, etag }: { key: string; value: unknown; etag: string | null }) => putRegistrySetting(key, value, etag),
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: agenticPolicyKeys.registrySetting(variables.key) });
      void queryClient.invalidateQueries({ queryKey: agenticPolicyKeys.liveConfig() });
    },
  });
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
