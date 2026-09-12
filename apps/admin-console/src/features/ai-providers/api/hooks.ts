'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteProviderConnection,
  getInferenceReadiness,
  getPlatformDefaults,
  getProviderConnection,
  listProviderConnections,
  listRoutingBindings,
  putConnectionModels,
  putProviderConnection,
  resetProviderConnection,
  testProviderConnection,
} from './client';
import { providerConnectionKeys } from './keys';
import type { DeclareConnectionModelsRequest, ProviderService, TestProviderConnectionRequest, UpsertProviderConnectionRequest } from './types';

export function useProviderConnection(service: ProviderService, slug: string, tenantId?: string, enabled = true) {
  return useQuery({
    queryKey: providerConnectionKeys.row(service, slug, tenantId),
    queryFn: () => getProviderConnection(service, slug, tenantId),
    enabled,
  });
}

/**
 * TASK-958 — every connection the scoped tenant holds for one capability.
 *
 * Read ONCE per tab and shared by every card group, which derives its own
 * provider's rows from it. A gateway that does not serve the multiplicity
 * fields yet answers the same array it always did, and `connectionSlugOf` /
 * `connectionIsDefault` make every row of it the default of its provider —
 * which is exactly what it is.
 */
export function useProviderConnections(service: ProviderService, tenantId?: string, enabled = true) {
  return useQuery({
    queryKey: providerConnectionKeys.list(service, tenantId),
    queryFn: () => listProviderConnections(service, tenantId),
    enabled,
  });
}

/** TASK-954 — the platform fallback the scoped tenant inherits for one service (read-only). */
export function usePlatformDefaults(service: ProviderService, tenantId?: string, enabled = true) {
  return useQuery({
    queryKey: providerConnectionKeys.platformDefaults(service, tenantId),
    queryFn: () => getPlatformDefaults(service, tenantId),
    enabled,
  });
}

export function usePutProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      service,
      slug,
      body,
      etag,
      tenantId,
    }: {
      service: ProviderService;
      slug: string;
      body: Omit<UpsertProviderConnectionRequest, 'expectedVersion'>;
      etag: string | null;
      tenantId?: string;
    }) => putProviderConnection(service, slug, body, etag, tenantId),
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service, variables.tenantId) }),
  });
}

/**
 * TASK-958 — "it worked" is the MUTATION's to say, not the call site's.
 *
 * The callbacks passed to `mutate(…, { onSuccess })` belong to the OBSERVER, and
 * TanStack Query v5 skips them once that observer has no listeners left. The
 * invalidation below drops the removed row from the list the group renders from,
 * which unmounts the card that issued the delete — so on a SIBLING the card's
 * own success toast never fired: the row simply vanished and the admin was told
 * nothing (rule 11 §5, "never silently succeed"). The DEFAULT card is always
 * rendered by its group, so it never unmounted and its toast always fired, which
 * is exactly why only siblings were silent.
 *
 * `onRemoved` is invoked from the MUTATION's `onSuccess`, which `Mutation.execute()`
 * runs (and awaits) before the invalidation that can unmount anything — so it
 * fires once per successful delete, from whichever card issued it.
 */
export function useDeleteProviderConnection(options?: { onRemoved?: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ service, slug, tenantId }: { service: ProviderService; slug: string; tenantId?: string }) =>
      deleteProviderConnection(service, slug, tenantId),
    onSuccess: (_data, variables) => {
      options?.onRemoved?.();
      return queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service, variables.tenantId) });
    },
  });
}

/**
 * TASK-890 §3.7a — declare a connection's models.
 *
 * Invalidates the ROW key as well as the service key: the declared list is part
 * of the single-row read, so the card must re-read it rather than keep the
 * list it just sent (the server generates the slugs).
 */
export function useDeclareConnectionModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      service,
      slug,
      body,
      tenantId,
    }: {
      service: ProviderService;
      slug: string;
      body: DeclareConnectionModelsRequest;
      tenantId?: string;
    }) => putConnectionModels(service, slug, body, tenantId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: providerConnectionKeys.row(variables.service, variables.slug, variables.tenantId) });
      void queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service, variables.tenantId) });
    },
  });
}

/** Ephemeral probe — no cache to invalidate, nothing persisted. */
export function useTestProviderConnection() {
  return useMutation({
    mutationFn: ({
      service,
      slug,
      body,
      tenantId,
    }: {
      service: ProviderService;
      slug: string;
      body: TestProviderConnectionRequest;
      tenantId?: string;
    }) => testProviderConnection(service, slug, body, tenantId),
  });
}

export function useRoutingBindings(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: providerConnectionKeys.bindings(tenantId),
    queryFn: () => listRoutingBindings(tenantId),
    enabled: enabled && Boolean(tenantId),
  });
}

/**
 * TASK-932 R-3 — reset one platform-managed row to its built-in default.
 *
 * Invalidates the ROW key as well as the service key: the card holds the ETag it
 * read, and the reset bumps the version server-side, so a card that kept its old
 * token would 412 on the operator's next save.
 */
export function useResetProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ service, slug, tenantId }: { service: ProviderService; slug: string; tenantId?: string }) =>
      resetProviderConnection(service, slug, tenantId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: providerConnectionKeys.row(variables.service, variables.slug, variables.tenantId) });
      void queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service, variables.tenantId) });
    },
  });
}

/**
 * The platform's last inference-readiness observation, for the engine cards.
 *
 * `unknown` is a real answer here, not a failure: a cold snapshot, a sweep that
 * is switched off, or an unreachable probe aggregator all mean "not measured",
 * and the card says so rather than implying a verdict nobody produced. A FAILED
 * read is therefore not retried into an error state — the cards simply show
 * nothing measured.
 */
export function useInferenceReadiness(enabled = true) {
  return useQuery({
    queryKey: providerConnectionKeys.readiness(),
    queryFn: getInferenceReadiness,
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}
