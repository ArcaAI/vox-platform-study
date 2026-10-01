'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GatewayError, getJson, type ListParams } from '@/shared/api';
import {
  abortUpload,
  cancelCheckpoint,
  completeUpload,
  createCheckpoint,
  deleteCheckpoint,
  getDownloadUrl,
  initUpload,
  listCheckpoints,
  listRestores,
  restoreCheckpoint,
} from './client';
import { checkpointKeys } from './keys';
import { isCheckpointActive, isRestoreActive, type CompletedPart, type CreateCheckpointRequest, type RestoreRequest } from './types';

export const POLL_INTERVAL_MS = 3000;

/** 423 on a mutation (or read) means a restore holds this tenant read-only. */
export function isRestoreLockError(error: unknown): boolean {
  return error instanceof GatewayError && error.status === 423;
}

export function useCheckpoints(tenantId: string, params?: ListParams) {
  return useQuery({
    queryKey: checkpointKeys.list(tenantId, params),
    queryFn: () => listCheckpoints(tenantId, params),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.data.some((row) => isCheckpointActive(row.status)) ? POLL_INTERVAL_MS : false),
  });
}

export function useRestores(tenantId: string, params?: ListParams) {
  return useQuery({
    queryKey: checkpointKeys.restores(tenantId, params),
    queryFn: () => listRestores(tenantId, params),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => (query.state.data?.data.some((row) => isRestoreActive(row.status)) ? POLL_INTERVAL_MS : false),
  });
}

function useInvalidate(tenantId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: checkpointKeys.tenant(tenantId) });
}

export function useCreateCheckpoint(tenantId: string) {
  const invalidate = useInvalidate(tenantId);
  return useMutation({ mutationFn: (body: CreateCheckpointRequest) => createCheckpoint(tenantId, body), onSuccess: invalidate });
}

export function useCancelCheckpoint(tenantId: string) {
  const invalidate = useInvalidate(tenantId);
  return useMutation({ mutationFn: (id: string) => cancelCheckpoint(tenantId, id), onSuccess: invalidate });
}

export function useDeleteCheckpoint(tenantId: string) {
  const invalidate = useInvalidate(tenantId);
  return useMutation({ mutationFn: (id: string) => deleteCheckpoint(tenantId, id), onSuccess: invalidate });
}

/** Mints a short-lived presigned URL; nothing to invalidate. */
export function useDownloadUrl(tenantId: string) {
  return useMutation({ mutationFn: (id: string) => getDownloadUrl(tenantId, id) });
}

export function useInitUpload(tenantId: string) {
  const invalidate = useInvalidate(tenantId);
  return useMutation({ mutationFn: (body: { filename: string; sizeBytes: number }) => initUpload(tenantId, body), onSuccess: invalidate });
}

export function useCompleteUpload(tenantId: string) {
  const invalidate = useInvalidate(tenantId);
  return useMutation({
    mutationFn: ({ uploadId, parts }: { uploadId: string; parts: CompletedPart[] }) => completeUpload(tenantId, uploadId, parts),
    onSuccess: invalidate,
  });
}

export function useAbortUpload(tenantId: string) {
  const invalidate = useInvalidate(tenantId);
  return useMutation({ mutationFn: (uploadId: string) => abortUpload(tenantId, uploadId), onSuccess: invalidate });
}

export function useRestoreCheckpoint(tenantId: string) {
  const invalidate = useInvalidate(tenantId);
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RestoreRequest }) => restoreCheckpoint(tenantId, id, body),
    onSuccess: invalidate,
  });
}

/**
 * The tenant's CURRENT name, which the restore break-glass matches exactly.
 * `knownName` short-circuits the fetch when the session already carries it.
 */
export function useTenantName(tenantId: string, knownName?: string | null) {
  return useQuery({
    queryKey: [...checkpointKeys.tenant(tenantId), 'tenant-name'],
    queryFn: () => getJson<{ name: string }>(`admin/tenants/${encodeURIComponent(tenantId)}`),
    enabled: !knownName,
    select: (tenant) => tenant.name,
  });
}
