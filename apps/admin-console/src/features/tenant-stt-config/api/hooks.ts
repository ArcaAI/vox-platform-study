'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSttCredentials, getSttEffective, getSttFallbackCandidates, getSttRow, putSttRow, removeSttCredential, setSttCredential } from './client';
import { sttConfigKeys } from './keys';
import type { SetSttCredentialRequest, SetSttFallbackRequest, SttProvider } from './types';

export function useSttEffective() {
  return useQuery({ queryKey: sttConfigKeys.effective(), queryFn: getSttEffective });
}

export function useSttRow() {
  return useQuery({ queryKey: sttConfigKeys.row(), queryFn: getSttRow });
}

/** Fallback pipeline options — a slow-moving reference list. */
export function useSttFallbackCandidates() {
  return useQuery({ queryKey: sttConfigKeys.fallbackCandidates(), queryFn: getSttFallbackCandidates, staleTime: 5 * 60 * 1000 });
}

export function useSttCredentials() {
  return useQuery({ queryKey: sttConfigKeys.credentials(), queryFn: getSttCredentials });
}

export function usePutSttRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patch, version }: { patch: Omit<SetSttFallbackRequest, 'expectedVersion'>; version: number }) => putSttRow(patch, version),
    // The row edit also moves the resolved effective config.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sttConfigKeys.root }),
  });
}

export function useSetSttCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, body, version }: { provider: SttProvider; body: Omit<SetSttCredentialRequest, 'expectedVersion'>; version: number }) =>
      setSttCredential(provider, body, version),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sttConfigKeys.credentials() }),
  });
}

export function useRemoveSttCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: SttProvider) => removeSttCredential(provider),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sttConfigKeys.credentials() }),
  });
}
