'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSttEffective, getSttFallbackCandidates, getSttRow, putSttRow } from './client';
import { sttConfigKeys } from './keys';
import type { SetSttFallbackRequest } from './types';

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

export function usePutSttRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ patch, version }: { patch: Omit<SetSttFallbackRequest, 'expectedVersion'>; version: number }) => putSttRow(patch, version),
    // The row edit also moves the resolved effective config.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sttConfigKeys.root }),
  });
}
