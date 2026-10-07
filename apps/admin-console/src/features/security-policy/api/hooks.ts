'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSecurityPolicy, updateSecurityPolicy } from './client';
import { securityPolicyKeys } from './keys';
import type { SecurityPolicy, UpdateSecurityPolicyRequest } from './types';

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
