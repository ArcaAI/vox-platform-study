'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteProviderConnection, getProviderConnection, putProviderConnection } from './providers-client';
import { providerConnectionKeys } from './providers-keys';
import type { CloudByoProvider, UpsertProviderConnectionRequest } from './providers-types';

export function useProviderConnection(provider: CloudByoProvider) {
  return useQuery({
    queryKey: providerConnectionKeys.row(provider),
    queryFn: () => getProviderConnection(provider),
  });
}

export function usePutProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      body,
      etag,
    }: {
      provider: CloudByoProvider;
      body: Omit<UpsertProviderConnectionRequest, 'expectedVersion'>;
      etag: string | null;
    }) => putProviderConnection(provider, body, etag),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providerConnectionKeys.root }),
  });
}

export function useDeleteProviderConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: CloudByoProvider) => deleteProviderConnection(provider),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: providerConnectionKeys.root }),
  });
}
