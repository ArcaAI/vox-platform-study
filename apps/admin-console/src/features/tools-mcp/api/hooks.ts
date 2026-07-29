'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createMcpServer, deleteMcpServer, getMcpServer, listMcpServers, updateMcpServer } from './client';
import { toolsMcpKeys } from './keys';
import type { CreateMcpServerRequest, UpdateMcpServerRequest } from './types';

/** SYSTEM MCP registry — mount only when the session is elevated (GLOBAL_ADMIN). */
export function useMcpServers(enabled: boolean) {
  return useQuery({ queryKey: toolsMcpKeys.list(), queryFn: listMcpServers, enabled });
}

/** Single server + ETag for OCC edit. */
export function useMcpServer(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: toolsMcpKeys.detail(id ?? ''),
    queryFn: () => getMcpServer(id!),
    enabled: enabled && Boolean(id),
  });
}

export function useCreateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateMcpServerRequest) => createMcpServer(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolsMcpKeys.list() }),
  });
}

export function useUpdateMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateMcpServerRequest; etag: string }) => updateMcpServer(id, patch, etag),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: toolsMcpKeys.list() });
      void queryClient.invalidateQueries({ queryKey: toolsMcpKeys.detail(variables.id) });
    },
  });
}

export function useDeleteMcpServer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, etag }: { id: string; etag: string }) => deleteMcpServer(id, etag),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: toolsMcpKeys.list() }),
  });
}
