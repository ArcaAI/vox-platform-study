'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateRoutingPolicy,
  createRoutingPolicy,
  deleteRoutingPolicy,
  exportRoutingPolicies,
  getEffectiveRoutingPolicy,
  importRoutingPolicies,
  listRoutingPolicies,
  promoteRoutingPolicy,
  setRoutingPolicyDefault,
  updateRoutingPolicy,
} from './client';
import { routingPolicyKeys } from './keys';
import type { CreateAiRoutingPolicyRequest, ProviderConfigurationExport, UpdateAiRoutingPolicyRequest } from './types';

/** Every provider configuration owned by one tenant, optionally narrowed to a task. */
export function useRoutingPolicies(tenantId: string, taskKey?: string, enabled = true) {
  return useQuery({
    queryKey: routingPolicyKeys.list(tenantId, taskKey),
    queryFn: () => listRoutingPolicies(tenantId, taskKey),
    enabled: enabled && Boolean(tenantId),
  });
}

/**
 * The resolved decision per task key, one query each.
 *
 * `useQueries` rather than a loop of `useQuery` because the task registry is a
 * fixed list read in one render — a hook per key would violate the rules of
 * hooks the moment the registry is filtered.
 */
export function useEffectiveRoutingPolicies(tenantId: string, taskKeys: readonly string[], enabled = true) {
  return useQueries({
    queries: taskKeys.map((taskKey) => ({
      queryKey: routingPolicyKeys.effective(tenantId, taskKey),
      queryFn: () => getEffectiveRoutingPolicy(tenantId, taskKey),
      enabled: enabled && Boolean(tenantId),
      // A 403 here means "the platform manages this", and a 404 means "not
      // yours" — neither is worth retrying, and retrying makes the screen feel
      // broken while it waits.
      retry: false,
    })),
  });
}

/** The secret-free export artifact. Fetched on demand, never on page load. */
export function useConfigurationExport(tenantId: string, taskKeys: string[] | undefined, enabled: boolean) {
  return useQuery({
    queryKey: routingPolicyKeys.export(tenantId, taskKeys),
    queryFn: () => exportRoutingPolicies(tenantId, taskKeys),
    enabled: enabled && Boolean(tenantId),
    retry: false,
  });
}

export function useCreateRoutingPolicy(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAiRoutingPolicyRequest) => createRoutingPolicy(tenantId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routingPolicyKeys.root }),
  });
}

export function useUpdateRoutingPolicy(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateAiRoutingPolicyRequest; etag: string }) =>
      updateRoutingPolicy(tenantId, id, patch, etag),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routingPolicyKeys.root }),
  });
}

/**
 * Elect a configuration as its task's default.
 *
 * The whole subtree is invalidated, not just the edited row: electing a new
 * default UNSETS the incumbent in the same transaction, so a narrower
 * invalidation would leave the previous default still wearing its badge.
 */
export function useSetRoutingPolicyDefault(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag }: { id: string; etag: string }) => setRoutingPolicyDefault(tenantId, id, etag),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routingPolicyKeys.root }),
  });
}

export function useActivateRoutingPolicy(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag }: { id: string; etag: string }) => activateRoutingPolicy(tenantId, id, etag),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routingPolicyKeys.root }),
  });
}

export function usePromoteRoutingPolicy(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetTenantId }: { id: string; targetTenantId: string }) => promoteRoutingPolicy(tenantId, id, targetTenantId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routingPolicyKeys.root }),
  });
}

export function useDeleteRoutingPolicy(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRoutingPolicy(tenantId, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routingPolicyKeys.root }),
  });
}

export function useImportConfigurations(tenantId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (artifact: ProviderConfigurationExport) => importRoutingPolicies(tenantId, artifact),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: routingPolicyKeys.root }),
  });
}
