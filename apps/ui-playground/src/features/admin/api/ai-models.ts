import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
//
// TASK-356 Phase 1 (Catalog plane). Mirrors `audio-pipelines.ts`: the admin
// AI model catalog is tenant-scoped via the `X-Tenant-Id` header and OCC-guarded
// on PATCH (the server stamps `ETag: "<version>"`; `If-Match` is required).
// Enum-like fields are kept as `string` on the wire (loose typing) exactly as
// `AudioPipeline.resourceStatus` is — the page supplies the option lists.
// ---------------------------------------------------------------------------

export interface AiModel {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  category: string;
  taskType: string;
  modelType: string;
  source: string;
  sourceUri: string;
  sourceRevision?: string | null;
  format: string;
  memorySizeMb?: number | null;
  computeType?: string | null;
  downloadStatus: string;
  resourceStatus: string;
  tags: string[];
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  // TASK-356 Phase 1 — row version for optimistic concurrency. The server
  // stamps `ETag: "<version>"` on every AiModel response and `If-Match` is
  // required on every PATCH.
  version?: number;
}

export interface PaginatedAiModels {
  data: AiModel[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface CreateAiModelInput {
  name: string;
  slug: string;
  description?: string;
  category: string;
  taskType: string;
  modelType: string;
  source: string;
  sourceUri: string;
  sourceRevision?: string;
  format: string;
  memorySizeMb?: number;
  computeType?: string;
  tags?: string[];
}

export interface UpdateAiModelInput {
  name?: string;
  slug?: string;
  description?: string;
  category?: string;
  taskType?: string;
  modelType?: string;
  source?: string;
  sourceUri?: string;
  sourceRevision?: string;
  format?: string;
  memorySizeMb?: number;
  computeType?: string;
  tags?: string[];
  // TASK-356 Phase 1 — required CAS predicate (echoed from the prior GET).
  // The controller folds the `If-Match` header value over this when both
  // are present.
  expectedVersion: number;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const aiModelKeys = {
  all: (tenantId?: string) => ['admin', 'ai-models', tenantId ?? ''] as const,
  list: (tenantId?: string) => [...aiModelKeys.all(tenantId), 'list'] as const,
  detail: (tenantId: string | undefined, id: string) => [...aiModelKeys.all(tenantId), 'detail', id] as const,
  slug: (tenantId: string | undefined, slug: string) => [...aiModelKeys.all(tenantId), 'slug', slug] as const,
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

/**
 * Admin AI model catalog for the exact caller tenant (ENABLED + DISABLED). The
 * backend `getAllForAdmin` filters to the exact `tenantId` so a tenant admin
 * sees only its own clone, never the SYSTEM original.
 */
export function useAiModels(tenantId: string, options?: Omit<UseQueryOptions<AiModel[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: aiModelKeys.list(tenantId),
    queryFn: () => adminClient.get<AiModel[]>('/admin/ai-models', { tenantId }),
    enabled: !!tenantId,
    ...options,
  });
}

export function useAiModel(tenantId: string, id: string, options?: Omit<UseQueryOptions<AiModel | null>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: aiModelKeys.detail(tenantId, id),
    queryFn: () => adminClient.get<AiModel | null>(`/admin/ai-models/${id}`, { tenantId }),
    enabled: !!id && !!tenantId,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export function useCreateAiModel(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAiModelInput) => adminClient.post<AiModel>('/admin/ai-models', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aiModelKeys.all(tenantId) });
    },
  });
}

export function useUpdateAiModel(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    // TASK-356 Phase 1 — `ifMatch` is forwarded as the RFC 7232
    // `If-Match: "<version>"` request header; the API folds its value over the
    // body-field `expectedVersion`. The PATCH route is `@RequiresIfMatch()` so
    // callers MUST supply `ifMatch` (or rely on `expectedVersion` as the body
    // fallback).
    mutationFn: ({ id, ifMatch, ...input }: UpdateAiModelInput & { id: string; ifMatch?: string }) =>
      adminClient.patch<AiModel>(`/admin/ai-models/${id}`, input, ifMatch ? { tenantId, ifMatch } : { tenantId }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: aiModelKeys.all(tenantId) });
      qc.invalidateQueries({ queryKey: aiModelKeys.detail(tenantId, variables.id) });
    },
  });
}

export function useDeleteAiModel(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<void>(`/admin/ai-models/${id}`, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aiModelKeys.all(tenantId) });
    },
  });
}
