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
  // TASK-328 A6 / TASK-331 doc-03 — whether this pipeline is the tenant's
  // default. Returned by `/admin/audio/pipelines` (PipelineResponse.isDefault);
  // the consolidated Backend Pipelines tab uses it for the default badge +
  // set-default gating.
  isDefault?: boolean;
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

// TODO(IC-08 / TASK-336 — DEFERRED): adopt the paginated
// `/admin/audio/pipelines/list` endpoint (envelope: `PaginatedAudioPipelines`)
// with page controls in the pipelines list. Deliberately left on the flat
// all-status `/admin/audio/pipelines` (admin `getAllForAdmin`) for now: the
// paginated route returns a different envelope, defaults to limit=20
// (truncation past page 1 without UI page controls), and its service-side
// `findAll` does not share the ENABLED+DISABLED semantics of IC-02's
// `findAllForAdmin` — so a naive switch would revert IC-02 and break consumers.
// Safe adoption needs an all-status paginated server route + FE page controls.
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
      adminClient.patch<AudioPipeline>(`/admin/audio/pipelines/${id}`, input, ifMatch ? { tenantId, ifMatch } : { tenantId }),
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
    mutationFn: (yaml: string) => adminClient.post<YamlValidationResult>('/admin/audio/pipelines/validate', { yaml }, { tenantId }),
  });
}
