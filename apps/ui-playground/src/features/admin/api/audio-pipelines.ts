import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioPipeline {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  configYaml: string;
  resourceStatus: string;
  tags: string[];
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  // TASK-302 Stream D Phase E.4 — row version for optimistic concurrency.
  // The server stamps `ETag: "<version>"` on every AsrPipeline response
  // and `If-Match` is required on every PATCH.
  version?: number;
}

export interface PaginatedAudioPipelines {
  data: AudioPipeline[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateAudioPipelineInput {
  name: string;
  slug: string;
  description?: string;
  configYaml: string;
  tags?: string[];
}

export interface UpdateAudioPipelineInput {
  name?: string;
  slug?: string;
  description?: string;
  configYaml?: string;
  tags?: string[];
  // TASK-302 Stream D Phase E.4 — required CAS predicate (echoed from
  // the prior GET). The controller folds the `If-Match` header value
  // over this when both are present.
  expectedVersion: number;
}

export interface YamlValidationResult {
  valid: boolean;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const audioPipelineKeys = {
  all: (tenantId?: string) => ['admin', 'audio/pipelines', tenantId ?? ''] as const,
  list: (tenantId?: string) => [...audioPipelineKeys.all(tenantId), 'list'] as const,
  detail: (tenantId: string | undefined, id: string) => [...audioPipelineKeys.all(tenantId), 'detail', id] as const,
  slug: (tenantId: string | undefined, slug: string) => [...audioPipelineKeys.all(tenantId), 'slug', slug] as const,
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

export function useAudioPipelines(tenantId: string, options?: Omit<UseQueryOptions<AudioPipeline[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: audioPipelineKeys.list(tenantId),
    queryFn: () => adminClient.get<AudioPipeline[]>('/admin/audio/pipelines', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useAudioPipeline(tenantId: string, id: string, options?: Omit<UseQueryOptions<AudioPipeline | null>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: audioPipelineKeys.detail(tenantId, id),
    queryFn: () =>
      adminClient.get<AudioPipeline | null>(`/admin/audio/pipelines/${id}`, {
        tenantId,
      }),
    enabled: !!id && !!tenantId,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreateAudioPipeline(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAudioPipelineInput) => adminClient.post<AudioPipeline>('/admin/audio/pipelines', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: audioPipelineKeys.all(tenantId) });
    },
  });
}

export function useUpdateAudioPipeline(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    // TASK-302 Stream D Phase E.4 — `ifMatch` is forwarded as the RFC 7232
    // `If-Match: "<version>"` request header; the API folds its value
    // over the body-field `expectedVersion`. The PATCH route is
    // `@RequiresIfMatch()` so callers MUST supply `ifMatch` (or rely on
    // `expectedVersion` as the body fallback before deploy ordering
    // catches up).
    mutationFn: ({ id, ifMatch, ...input }: UpdateAudioPipelineInput & { id: string; ifMatch?: string }) =>
      adminClient.patch<AudioPipeline>(
        `/admin/audio/pipelines/${id}`,
        input,
        ifMatch ? { tenantId, ifMatch } : { tenantId },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: audioPipelineKeys.all(tenantId) });
      qc.invalidateQueries({
        queryKey: audioPipelineKeys.detail(tenantId, variables.id),
      });
    },
  });
}

export function useDeleteAudioPipeline(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<void>(`/admin/audio/pipelines/${id}`, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: audioPipelineKeys.all(tenantId) });
    },
  });
}

export function useValidateAudioPipelineYaml(tenantId: string) {
  return useMutation({
    mutationFn: (yaml: string) => adminClient.post<YamlValidationResult>('/admin/audio/pipelines/validate-yaml', { yaml }, { tenantId }),
  });
}
