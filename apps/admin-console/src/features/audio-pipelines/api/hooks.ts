'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignPipelineTenant,
  clonePipeline,
  createPipeline,
  deletePipeline,
  getPipeline,
  listPipelineVersions,
  listPipelines,
  setDefaultPipeline,
  togglePipeline,
  updatePipeline,
  validatePipelineConfig,
} from './client';
import { audioPipelineKeys } from './keys';
import type { ClonePipelineRequest, CreatePipelineRequest, UpdatePipelineRequest } from './types';

export function usePipelines() {
  return useQuery({ queryKey: audioPipelineKeys.list(), queryFn: listPipelines });
}

/** Detail read whose ETag backs the config-editor PATCH and the toggle. */
export function usePipeline(id: string | null) {
  return useQuery({ queryKey: audioPipelineKeys.detail(id ?? ''), queryFn: () => getPipeline(id as string), enabled: !!id });
}

export function usePipelineVersions(id: string | null) {
  return useQuery({ queryKey: audioPipelineKeys.versions(id ?? ''), queryFn: () => listPipelineVersions(id as string), enabled: !!id });
}

function useInvalidatePipelines() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: audioPipelineKeys.root });
}

export function useCreatePipeline() {
  const invalidate = useInvalidatePipelines();
  return useMutation({ mutationFn: (body: CreatePipelineRequest) => createPipeline(body), onSuccess: invalidate });
}

export function useUpdatePipeline() {
  const invalidate = useInvalidatePipelines();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdatePipelineRequest; etag: string }) => updatePipeline(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeletePipeline() {
  const invalidate = useInvalidatePipelines();
  return useMutation({ mutationFn: (id: string) => deletePipeline(id), onSuccess: invalidate });
}

/** Clone a pipeline (the customization path for locked copies). */
export function useClonePipeline() {
  const invalidate = useInvalidatePipelines();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ClonePipelineRequest }) => clonePipeline(id, body),
    onSuccess: invalidate,
  });
}

/** Preflight-only — no cache invalidation on purpose (nothing changed). */
export function useValidatePipelineConfig() {
  return useMutation({ mutationFn: (configYaml: string) => validatePipelineConfig(configYaml) });
}

export function useAssignPipelineTenant() {
  const invalidate = useInvalidatePipelines();
  return useMutation({
    mutationFn: ({ id, tenantId }: { id: string; tenantId: string }) => assignPipelineTenant(id, tenantId),
    onSuccess: invalidate,
  });
}

export function useSetDefaultPipeline() {
  const invalidate = useInvalidatePipelines();
  return useMutation({ mutationFn: (id: string) => setDefaultPipeline(id), onSuccess: invalidate });
}

export function useTogglePipeline() {
  const invalidate = useInvalidatePipelines();
  return useMutation({
    mutationFn: ({ id, enabled, etag }: { id: string; enabled: boolean; etag: string }) => togglePipeline(id, enabled, etag),
    onSuccess: invalidate,
  });
}
