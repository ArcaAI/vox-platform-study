'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteProviderConnection, getProviderConnection, putProviderConnection } from './client';
import { providerConnectionKeys } from './keys';
import type { ProviderService, UpsertProviderConnectionRequest } from './types';

export function useProviderConnection(service: ProviderService, provider: string) {
  return useQuery({
    queryKey: providerConnectionKeys.row(service, provider),
    queryFn: () => getProviderConnection(service, provider),
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
    }: {
      service: ProviderService;
      provider: string;
      body: Omit<UpsertProviderConnectionRequest, 'expectedVersion'>;
      etag: string | null;
    }) => putProviderConnection(service, provider, body, etag),
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service) }),
  });
}

export function useDeleteProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ service, provider }: { service: ProviderService; provider: string }) => deleteProviderConnection(service, provider),
    onSuccess: (_data, variables) => queryClient.invalidateQueries({ queryKey: providerConnectionKeys.service(variables.service) }),
  });
}
