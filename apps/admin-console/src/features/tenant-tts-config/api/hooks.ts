'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getTtsCatalog, getTtsEffective, getTtsRow, putTtsRow } from './client';
import { ttsConfigKeys } from './keys';
import type { UpdateTtsConfigRequest } from './types';

export function useTtsEffective() {
  return useQuery({ queryKey: ttsConfigKeys.effective(), queryFn: getTtsEffective });
}

export function useTtsRow() {
  return useQuery({ queryKey: ttsConfigKeys.row(), queryFn: getTtsRow });
}

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
