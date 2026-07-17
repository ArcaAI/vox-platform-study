'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getTtsCatalog, getTtsCredentials, getTtsEffective, getTtsRow, putTtsRow, removeTtsCredential, setTtsCredential } from './client';
import { ttsConfigKeys } from './keys';
import type { SetTtsCredentialRequest, TtsProvider, UpdateTtsConfigRequest } from './types';

export function useTtsEffective() {
  return useQuery({ queryKey: ttsConfigKeys.effective(), queryFn: getTtsEffective });
}

export function useTtsRow() {
  return useQuery({ queryKey: ttsConfigKeys.row(), queryFn: getTtsRow });
}

export function useTtsCredentials() {
  return useQuery({ queryKey: ttsConfigKeys.credentials(), queryFn: getTtsCredentials });
}

/** Platform TTS catalog (TASK-506) — a slow-moving reference list. */
export function useTtsCatalog() {
  return useQuery({ queryKey: ttsConfigKeys.catalog(), queryFn: getTtsCatalog, staleTime: 5 * 60 * 1000 });
}

export function usePutTtsRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patch, etag }: { patch: Omit<UpdateTtsConfigRequest, 'expectedVersion'>; etag: string | null }) => putTtsRow(patch, etag),
    // The row edit also moves the resolved effective config.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ttsConfigKeys.root }),
  });
}

export function useSetTtsCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, body }: { provider: TtsProvider; body: SetTtsCredentialRequest }) => setTtsCredential(provider, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ttsConfigKeys.credentials() }),
  });
}

export function useRemoveTtsCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: TtsProvider) => removeTtsCredential(provider),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ttsConfigKeys.credentials() }),
  });
}
