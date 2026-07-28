'use client';

import { useQuery } from '@tanstack/react-query';
import { getAgenticInstructions, getGuardrailConfig, getGuardrailStatus, getNlpStatus } from './client';
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
