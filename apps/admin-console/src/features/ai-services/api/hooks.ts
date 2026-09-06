'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAgenticInstructions,
  getGuardrailConfig,
  getGuardrailStatus,
  getInferenceReadiness,
  getNlpStatus,
  refreshInferenceReadiness,
} from './client';
import { aiServicesKeys } from './keys';
import type { AgenticInstructionsParams } from './types';

export function useGuardrailStatus() {
  return useQuery({ queryKey: aiServicesKeys.guardrailStatus(), queryFn: getGuardrailStatus });
}

export function useGuardrailConfig() {
  return useQuery({ queryKey: aiServicesKeys.guardrailConfig(), queryFn: getGuardrailConfig });
}

export function useNlpStatus() {
  return useQuery({ queryKey: aiServicesKeys.nlpStatus(), queryFn: getNlpStatus });
}

/**
 * Tenant-scoped read from a (global)-tier screen —
 * `enabled` keeps the query parked until a working tenant is known, so an
 * elevated session without one never fires a request that can only 400.
 */
export function useAgenticInstructions(params: AgenticInstructionsParams, enabled: boolean) {
  return useQuery({
    queryKey: aiServicesKeys.instructions(params),
    queryFn: () => getAgenticInstructions(params),
    enabled,
  });
}

/**
 * The stored readiness observation.
 *
 * `retry: false` for the same reason the engine screens use it: the answer to
 * "is the platform serving" is the document itself, and a failed READ is a
 * gateway problem the screen should say plainly rather than hide behind three
 * silent retries. Refetched on an interval because the sweep behind it moves on
 * its own — the panel would otherwise show an ever-older `checkedAt` while
 * looking live.
 */
export function useInferenceReadiness() {
  return useQuery({
    queryKey: aiServicesKeys.readiness(),
    queryFn: getInferenceReadiness,
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

/**
 * "Probe now". The response IS the new observation, so it is written straight
 * into the cache rather than invalidated — a second GET would only re-read what
 * we already hold.
 */
export function useRefreshInferenceReadiness() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshInferenceReadiness,
    onSuccess: (snapshot) => queryClient.setQueryData(aiServicesKeys.readiness(), snapshot),
  });
}
