import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { adminClient } from './admin-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PromptTemplateCategory = 'SYSTEM' | 'SUMMARY' | 'PRE_SUMMARY' | 'DNA_ANALYSIS' | 'CUSTOM';

export type PromptTemplateStatus = 'DRAFT' | 'PUBLISHED';

export interface PromptVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
  default?: unknown;
  description?: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  description?: string;
  category: PromptTemplateCategory;
  status?: PromptTemplateStatus;
  departmentId?: string;
  content: string;
  variables?: PromptVariable[];
  tags?: string[];
  currentVersionNumber: number;
  resourceStatus?: string;
  createdAt: string;
  updatedAt: string;
  // TASK-302 Stream D Phase E.3 — row's optimistic-concurrency version
  // (`_version` in the DB). Distinct from `currentVersionNumber`, the
  // PromptVersion history counter. Echo this back via `If-Match` or
  // `expectedVersion` on the next PATCH.
  version?: number;
  [key: string]: unknown;
}

export interface PromptVersion {
  id: string;
  promptTemplateId: string;
  versionNumber: number;
  content: string;
  variables?: PromptVariable[];
  changeReason?: string;
  changedBy?: string;
  createdAt: string;
}

export interface PromptUsageStats {
  totalUsages: number;
  lastUsedAt: string | null;
}

export interface CreatePromptInput {
  name: string;
  description?: string;
  category: PromptTemplateCategory;
  status?: PromptTemplateStatus;
  departmentId?: string;
  content: string;
  variables?: PromptVariable[];
  tags?: string[];
}

export interface UpdatePromptInput {
  description?: string;
  content?: string;
  status?: PromptTemplateStatus;
  variables?: PromptVariable[];
  tags?: string[];
  changeReason?: string;
  resourceStatus?: string;
  // TASK-302 Stream D Phase E.3 — required CAS predicate (echoed from
  // the prior GET). The API folds the `If-Match` header over this when
  // both are present.
  expectedVersion: number;
}

export type DepartmentPromptField = 'newPatientPromptId' | 'revisitPromptId' | 'summaryPromptId' | 'preSummaryPromptId';

export interface AssignDepartmentPromptInput {
  departmentId: string;
  promptTemplateId: string;
  field: DepartmentPromptField;
}

interface PaginatedResponse<T> {
  data: T[];
  count: number;
  limit: number;
  page: number;
}

interface PromptListParams {
  page?: number;
  limit?: number;
  category?: PromptTemplateCategory;
  search?: string;
  departmentId?: string;
  includeDisabled?: boolean;
}

const PROMPT_TEMPLATES_STALE_TIME_MS = 60_000;
const PROMPT_TEMPLATES_GC_TIME_MS = 10 * 60_000;
const PROMPT_USAGE_STALE_TIME_MS = 15_000;

// ---------------------------------------------------------------------------
// Query keys — include tenantId so cache is per-tenant
// ---------------------------------------------------------------------------

const keys = {
  all: (tenantId?: string) => ['admin', 'prompts', tenantId ?? ''] as const,
  lists: (tenantId?: string) => [...keys.all(tenantId), 'list'] as const,
  list: (tenantId?: string, params?: PromptListParams) => [...keys.lists(tenantId), params] as const,
  details: (tenantId?: string) => [...keys.all(tenantId), 'detail'] as const,
  detail: (tenantId: string | undefined, id: string) => [...keys.details(tenantId), id] as const,
  versions: (tenantId: string | undefined, id: string) => [...keys.all(tenantId), 'versions', id] as const,
  version: (tenantId: string | undefined, id: string, v: number) => [...keys.all(tenantId), 'version', id, v] as const,
  usage: (tenantId: string | undefined, id: string) => [...keys.all(tenantId), 'usage', id] as const,
};

function qs(params?: PromptListParams): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(([, v]) => v != null);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

// ---------------------------------------------------------------------------
// Query hooks — all accept tenantId for super-admin tenant switching
// ---------------------------------------------------------------------------

export function usePromptTemplates(
  tenantId: string,
  params?: PromptListParams,
  options?: Omit<UseQueryOptions<PaginatedResponse<PromptTemplate>>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    queryKey: keys.list(tenantId, params),
    queryFn: () => adminClient.get<PaginatedResponse<PromptTemplate>>(`/prompt-templates${qs(params)}`, { tenantId }),
    enabled: !!tenantId,
    staleTime: PROMPT_TEMPLATES_STALE_TIME_MS,
    gcTime: PROMPT_TEMPLATES_GC_TIME_MS,
    ...options,
  });
}

const DEFAULT_INFINITE_PAGE_SIZE = 25;

export function usePromptTemplatesInfinite(
  tenantId: string,
  params?: Omit<PromptListParams, 'page' | 'limit'>,
  pageSize = DEFAULT_INFINITE_PAGE_SIZE,
) {
  return useInfiniteQuery({
    queryKey: [...keys.lists(tenantId), 'infinite', params, pageSize] as const,
    queryFn: ({ pageParam }) =>
      adminClient.get<PaginatedResponse<PromptTemplate>>(`/prompt-templates${qs({ ...params, page: pageParam, limit: pageSize })}`, { tenantId }),
    initialPageParam: 1,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      const fetched = lastPageParam * pageSize;
      return fetched < lastPage.count ? lastPageParam + 1 : undefined;
    },
    enabled: !!tenantId,
    staleTime: PROMPT_TEMPLATES_STALE_TIME_MS,
    gcTime: PROMPT_TEMPLATES_GC_TIME_MS,
  });
}

export function usePromptTemplate(tenantId: string, id: string, options?: Omit<UseQueryOptions<PromptTemplate>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.detail(tenantId, id),
    queryFn: () => adminClient.get<PromptTemplate>(`/prompt-templates/${id}`, { tenantId }),
    enabled: !!id && !!tenantId,
    staleTime: PROMPT_TEMPLATES_STALE_TIME_MS,
    gcTime: PROMPT_TEMPLATES_GC_TIME_MS,
    ...options,
  });
}

export function usePromptVersions(tenantId: string, templateId: string, options?: Omit<UseQueryOptions<PromptVersion[]>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.versions(tenantId, templateId),
    queryFn: () => adminClient.get<PromptVersion[]>(`/prompt-templates/${templateId}/versions`, { tenantId }),
    enabled: !!templateId && !!tenantId,
    staleTime: PROMPT_TEMPLATES_STALE_TIME_MS,
    gcTime: PROMPT_TEMPLATES_GC_TIME_MS,
    ...options,
  });
}

export function usePromptUsageStats(tenantId: string, templateId: string, options?: Omit<UseQueryOptions<PromptUsageStats>, 'queryKey' | 'queryFn'>) {
  return useQuery({
    queryKey: keys.usage(tenantId, templateId),
    queryFn: () => adminClient.get<PromptUsageStats>(`/prompt-templates/${templateId}/usage`, { tenantId }),
    enabled: !!templateId && !!tenantId,
    staleTime: PROMPT_USAGE_STALE_TIME_MS,
    gcTime: PROMPT_TEMPLATES_GC_TIME_MS,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks — all accept tenantId
// ---------------------------------------------------------------------------

export function useCreatePrompt(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePromptInput) => adminClient.post<PromptTemplate>('/prompt-templates', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all(tenantId) });
    },
  });
}

export function useUpdatePrompt(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    // TASK-302 Stream D Phase E.3 — `ifMatch` is forwarded as the RFC 7232
    // `If-Match: "<version>"` request header; the API folds its value
    // over the body-field `expectedVersion`. The route is
    // `@RequiresIfMatch()` so callers MUST supply `ifMatch` (or rely on
    // `expectedVersion` as the body fallback before the header guard
    // lands in CI).
    mutationFn: ({ id, ifMatch, ...input }: UpdatePromptInput & { id: string; ifMatch?: string }) =>
      adminClient.patch<PromptTemplate>(
        `/prompt-templates/${id}`,
        input,
        ifMatch ? { tenantId, ifMatch } : { tenantId },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all(tenantId) });
      qc.invalidateQueries({ queryKey: keys.detail(tenantId, variables.id) });
      qc.invalidateQueries({ queryKey: keys.versions(tenantId, variables.id) });
    },
  });
}

export function useDeletePrompt(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => adminClient.delete<void>(`/prompt-templates/${id}`, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all(tenantId) });
    },
  });
}

export function useTogglePromptStatus(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    // TASK-302 Stream D Phase E.3 — same `@RequiresIfMatch()` PATCH route
    // as `useUpdatePrompt`. The caller must supply `expectedVersion` and
    // (in production) `ifMatch`. Toggle is a status-only mutation that
    // still bumps `_version` like any other write.
    mutationFn: ({ id, resourceStatus, expectedVersion, ifMatch }: { id: string; resourceStatus: string; expectedVersion: number; ifMatch?: string }) =>
      adminClient.patch<PromptTemplate>(
        `/prompt-templates/${id}`,
        { resourceStatus, expectedVersion },
        ifMatch ? { tenantId, ifMatch } : { tenantId },
      ),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all(tenantId) });
      qc.invalidateQueries({ queryKey: keys.detail(tenantId, variables.id) });
    },
  });
}

export function useAssignDepartmentPrompt(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignDepartmentPromptInput) => adminClient.post<void>('/prompt-templates/assign-department', input, { tenantId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.all(tenantId) });
    },
  });
}

export function useActivatePromptVersion(tenantId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, versionNumber }: { templateId: string; versionNumber: number }) =>
      adminClient.post<PromptTemplate>(`/prompt-templates/${templateId}/versions/${versionNumber}/activate`, undefined, { tenantId }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: keys.all(tenantId) });
      qc.invalidateQueries({
        queryKey: keys.detail(tenantId, variables.templateId),
      });
      qc.invalidateQueries({
        queryKey: keys.versions(tenantId, variables.templateId),
      });
    },
  });
}

export function useRefreshPromptDetails(tenantId: string) {
  const qc = useQueryClient();

  return async (promptId: string) => {
    if (!tenantId || !promptId) {
      return;
    }

    await Promise.all([
      qc.invalidateQueries({
        queryKey: keys.versions(tenantId, promptId),
      }),
      qc.invalidateQueries({
        queryKey: keys.detail(tenantId, promptId),
      }),
      qc.invalidateQueries({
        queryKey: keys.usage(tenantId, promptId),
      }),
    ]);
  };
}

export { keys as promptKeys };
