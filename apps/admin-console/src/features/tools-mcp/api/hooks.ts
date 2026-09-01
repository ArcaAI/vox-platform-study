'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createMcpServer, deleteMcpServer, getMcpGate, getMcpServer, listMcpServers, updateMcpServer } from './client';
import { toolsMcpKeys } from './keys';
import type { CreateMcpServerRequest, UpdateMcpServerRequest } from './types';

/**
 * The registry visible to the caller: own-tenant connectors plus the
 * SYSTEM-shared rows. Since OD-7 this is NOT super-admin-only — a tenant admin
 * holding `manage:McpServer` mounts it too.
 */
export function useMcpServers(enabled: boolean) {
  return useQuery({ queryKey: toolsMcpKeys.list(), queryFn: listMcpServers, enabled });
}

/**
 * The effective `mcpToolsEnabled` gate for the caller's tenant (OD-11).
 * Advisory only: it drives a banner, never a permission decision, so a caller
 * without `read:HarnessPolicy` simply gets no banner instead of a broken screen.
 */
export function useMcpGate(enabled: boolean) {
  return useQuery({ queryKey: toolsMcpKeys.gate(), queryFn: getMcpGate, enabled, retry: false });
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
