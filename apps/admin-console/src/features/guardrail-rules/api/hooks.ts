'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getGuardrailPolicy, putGuardrailPolicy } from './client';
import { guardrailRulesKeys } from './keys';
import type { TenantGuardrailPolicy, UpdateTenantGuardrailPolicyRequest } from './types';

export function useGuardrailPolicy(tenantId: string) {
  return useQuery({ queryKey: guardrailRulesKeys.policy(tenantId), queryFn: getGuardrailPolicy });
}

/** Single-row OCC write: the response IS the re-read policy, so it seeds the cache; a failure invalidates so the next read carries the winning version. */
export function useUpdateGuardrailPolicy(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, version }: { body: UpdateTenantGuardrailPolicyRequest; version: number }) => putGuardrailPolicy(body, version),
    onSuccess: (policy: TenantGuardrailPolicy) => queryClient.setQueryData(guardrailRulesKeys.policy(tenantId), policy),
    onError: () => void queryClient.invalidateQueries({ queryKey: guardrailRulesKeys.policy(tenantId) }),
  });
}
