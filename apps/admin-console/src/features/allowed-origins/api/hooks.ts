'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAllowedOrigin, deleteAllowedOrigin, getAllowedOrigin, listAllowedOrigins, updateAllowedOrigin } from './client';
import { allowedOriginKeys } from './keys';
import type { CreateAllowedOriginRequest, UpdateAllowedOriginRequest } from './types';

export function useAllowedOrigins(enabled: boolean) {
  return useQuery({ queryKey: allowedOriginKeys.list(), queryFn: listAllowedOrigins, enabled });
}

export function useAllowedOrigin(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: allowedOriginKeys.detail(id ?? ''),
    queryFn: () => getAllowedOrigin(id!),
    enabled: enabled && Boolean(id),
  });
}

export function useCreateAllowedOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateAllowedOriginRequest) => createAllowedOrigin(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: allowedOriginKeys.list() }),
  });
}

export function useUpdateAllowedOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateAllowedOriginRequest; etag: string }) => updateAllowedOrigin(id, patch, etag),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: allowedOriginKeys.list() });
      void queryClient.invalidateQueries({ queryKey: allowedOriginKeys.detail(variables.id) });
    },
  });
}

export function useDeleteAllowedOrigin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAllowedOrigin(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: allowedOriginKeys.list() }),
  });
}
