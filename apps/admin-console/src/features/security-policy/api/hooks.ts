'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getGuardrailAvailability,
  getGuardrailPolicyCatalogue,
  getSecurityPolicy,
  putGuardrailAvailability,
  updateSecurityPolicy,
} from './client';
import { securityPolicyKeys } from './keys';
import type { GuardrailAvailability, SecurityPolicy, UpdateGuardrailAvailabilityRequest, UpdateSecurityPolicyRequest } from './types';

export function useSecurityPolicy() {
  return useQuery({ queryKey: securityPolicyKeys.policy(), queryFn: getSecurityPolicy });
}

/**
 * The PUT is not transactional — each key is its own row — so on a FAILURE the
 * server state is unknown (some keys may have landed). Invalidate on settle,
 * not only on success, so the screen never keeps showing a policy that a
 * partially-applied write has already moved.
 */
export function useUpdateSecurityPolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSecurityPolicyRequest) => updateSecurityPolicy(body),
    onSuccess: (policy: SecurityPolicy) => queryClient.setQueryData(securityPolicyKeys.policy(), policy),
    onError: () => void queryClient.invalidateQueries({ queryKey: securityPolicyKeys.policy() }),
  });
}

// ── Guardrail availability (TASK-886) ────────────────────────────────────────

/** The selectable policy catalogue — static per deployment, so cached hard. */
export function useGuardrailPolicyCatalogue() {
  return useQuery({ queryKey: securityPolicyKeys.guardrailCatalogue(), queryFn: getGuardrailPolicyCatalogue, staleTime: Infinity });
}

/** One tenant's selection plus the EFFECTIVE set the cascade resolves for it. */
export function useGuardrailAvailability(tenantId: string | null) {
  return useQuery({
    queryKey: securityPolicyKeys.guardrailAvailability(tenantId ?? ''),
    queryFn: () => getGuardrailAvailability(tenantId as string),
    enabled: Boolean(tenantId),
  });
}

/**
 * The write is a single-row OCC PUT, so unlike the credential-policy mutation
 * above a failure leaves the row untouched — there is no partial-apply to
 * recover from. The response IS the re-read row (own selection + effective set),
 * so it seeds the cache directly; a 412 invalidates so the next read carries the
 * version that actually won.
 */
export function useUpdateGuardrailAvailability(tenantId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, version }: { body: UpdateGuardrailAvailabilityRequest; version: number }) =>
      putGuardrailAvailability(tenantId as string, body, version),
    onSuccess: (row: GuardrailAvailability) => queryClient.setQueryData(securityPolicyKeys.guardrailAvailability(tenantId ?? ''), row),
    onError: () => void queryClient.invalidateQueries({ queryKey: securityPolicyKeys.guardrailAvailability(tenantId ?? '') }),
  });
}
