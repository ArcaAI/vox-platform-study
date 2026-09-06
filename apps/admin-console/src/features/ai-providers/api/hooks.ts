'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deleteProviderConnection,
  getProviderConnection,
  listRoutingBindings,
  putConnectionModels,
  putProviderConnection,
  testProviderConnection,
} from './client';
import { providerConnectionKeys } from './keys';
import type { DeclareConnectionModelsRequest, ProviderService, TestProviderConnectionRequest, UpsertProviderConnectionRequest } from './types';

export function useProviderConnection(service: ProviderService, provider: string, tenantId?: string, enabled = true) {
  return useQuery({
    queryKey: providerConnectionKeys.row(service, provider, tenantId),
    queryFn: () => getProviderConnection(service, provider, tenantId),
    enabled,
  });
}

export function usePutProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      service,
      provider,
      body,
      etag,
      tenantId,
    }: {
      service: ProviderService;
      provider: string;
      body: Omit<UpsertProviderConnectionRequest, 'expectedVersion'>;
      etag: string | null;
      tenantId?: string;
    }) => putProviderConnection(service, provider, body, etag, tenantId),
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service, variables.tenantId) }),
  });
}

export function useDeleteProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ service, provider, tenantId }: { service: ProviderService; provider: string; tenantId?: string }) =>
      deleteProviderConnection(service, provider, tenantId),
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service, variables.tenantId) }),
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
      provider,
      body,
      tenantId,
    }: {
      service: ProviderService;
      provider: string;
      body: DeclareConnectionModelsRequest;
      tenantId?: string;
    }) => putConnectionModels(service, provider, body, tenantId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: providerConnectionKeys.row(variables.service, variables.provider, variables.tenantId) });
      void queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service, variables.tenantId) });
    },
  });
}

/** Ephemeral probe — no cache to invalidate, nothing persisted. */
export function useTestProviderConnection() {
  return useMutation({
    mutationFn: ({
      service,
      provider,
      body,
      tenantId,
    }: {
      service: ProviderService;
      provider: string;
      body: TestProviderConnectionRequest;
      tenantId?: string;
    }) => testProviderConnection(service, provider, body, tenantId),
  });
}

export function useRoutingBindings(tenantId: string, enabled = true) {
  return useQuery({
    queryKey: providerConnectionKeys.bindings(tenantId),
    queryFn: () => listRoutingBindings(tenantId),
    enabled: enabled && Boolean(tenantId),
  });
}
