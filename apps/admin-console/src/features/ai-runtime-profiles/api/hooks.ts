'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteRuntimeProfile, getRuntimeProfile, listRuntimeProfiles, resolveRuntimeProfile, upsertRuntimeProfile } from './client';
import { runtimeProfileKeys } from './keys';
import type { UpsertAiRuntimeProfileRequest } from './types';

export function useRuntimeProfiles(enabled = true) {
  return useQuery({
    queryKey: runtimeProfileKeys.list(),
    queryFn: () => listRuntimeProfiles(),
    enabled,
  });
}

/** One row + ETag. Disabled until a (provider, model) pair is actually selected. */
export function useRuntimeProfile(provider: string | null, modelSlug: string, enabled = true) {
  return useQuery({
    queryKey: runtimeProfileKeys.row(provider ?? '', modelSlug),
    queryFn: () => getRuntimeProfile(provider!, modelSlug),
    enabled: enabled && provider !== null,
  });
}

/** The merged cascade — what the gateway would actually inject. */
export function useResolvedRuntimeProfile(provider: string | null, modelSlug: string, enabled = true) {
  return useQuery({
    queryKey: runtimeProfileKeys.resolved(provider ?? '', modelSlug),
    queryFn: () => resolveRuntimeProfile(provider!, modelSlug),
    enabled: enabled && provider !== null,
  });
}

export function useUpsertRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      modelSlug,
      body,
      etag,
    }: {
      provider: string;
      modelSlug: string;
      body: Omit<UpsertAiRuntimeProfileRequest, 'expectedVersion'>;
      etag: string | null;
    }) => upsertRuntimeProfile(provider, modelSlug, body, etag),
    // The whole subtree: a write to the provider-DEFAULT row changes what every
    // model under it resolves to, so invalidating only the edited row would
    // leave sibling rows showing a stale inherited value.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runtimeProfileKeys.root }),
  });
}

export function useDeleteRuntimeProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, modelSlug }: { provider: string; modelSlug: string }) => deleteRuntimeProfile(provider, modelSlug),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: runtimeProfileKeys.root }),
  });
}
