'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getEngineConnection, getEngineDiscovery, listEngineArtifacts } from './client';
import { inferenceEngineKeys } from './keys';
import type { InferenceEngineProvider } from './types';

/**
 * The engine probe.
 *
 * `retry: false` on purpose. Both engines ship at `replicas: 0` today, so an
 * unreachable engine is the EXPECTED answer, not a transient fault — retrying
 * three times only makes the screen take three times as long to tell the
 * operator the truth. The probe result itself (`probes[].probeStatus`) carries
 * "unreachable"; a rejected query means the GATEWAY read failed, which is a
 * different and much rarer thing, and the screen distinguishes the two.
 *
 * Unlike `/ai-models`' drawer this is NOT lazily gated: the probe IS the screen,
 * so parking it behind an interaction would leave the page with nothing to say.
 */
export function useEngineDiscovery(provider: InferenceEngineProvider) {
  return useQuery({
    queryKey: inferenceEngineKeys.discovery(provider),
    queryFn: () => getEngineDiscovery(provider),
    staleTime: 30_000,
    retry: false,
  });
}

/** The connection row. Absent rows come back as a `version: 0` placeholder, not an error. */
export function useEngineConnection(provider: InferenceEngineProvider) {
  return useQuery({
    queryKey: inferenceEngineKeys.connection(provider),
    queryFn: () => getEngineConnection(provider),
    staleTime: 30_000,
  });
}

/**
 * Weight artifacts. `enabled` keeps the listing parked until its tab is opened —
 * the bucket read is unrelated to the engine's health and must not delay it.
 */
export function useEngineArtifacts(provider: InferenceEngineProvider, prefix: string, enabled: boolean) {
  return useQuery({
    queryKey: inferenceEngineKeys.artifacts(provider, prefix),
    queryFn: () => listEngineArtifacts(prefix),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** "Probe now" — drops every cached read for THIS engine only. */
export function useRefreshEngine(provider: InferenceEngineProvider) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: inferenceEngineKeys.engine(provider) });
}
