'use client';

/**
 * TanStack Query v5 hooks for the agents surface. Mutations invalidate the
 * whole ['agents'] namespace — an admin console prefers fresh reads over
 * cache cleverness (rule 13). The deliberate exceptions: useTestTemplate and
 * useFinalizeTemplateTest invalidate NOTHING — the ack writes nothing at all,
 * and the finalize result carries the row's new OCC version directly.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Paginated } from '@/shared/api';
import {
  activateVersion,
  approveTemplate,
  assignDepartment,
  createDepartmentAgent,
  createTemplate,
  deleteDepartmentAgent,
  deleteTemplate,
  diffVersions,
  finalizeTemplateTest,
  getDepartmentAgent,
  getResolvedContextSchema,
  getTemplate,
  getUsageAnalytics,
  getUsageStats,
  listAgentEvalRuns,
  listAgentPromotions,
  listDepartmentAgents,
  listDepartmentAgentVersions,
  listDepartments,
  listEvalGoldenCases,
  listEvalGoldenSets,
  listTemplates,
  listUsageRecords,
  listVersions,
  pinDepartmentAgent,
  runGoldenSetEval,
  setDefaultDepartmentAgent,
  testTemplate,
  updateDepartmentAgent,
  updateTemplate,
} from './client';
import { agentEvalKeys, agentKeys, agentPromotionKeys, departmentAgentKeys } from './keys';
import type {
  AssignDepartmentRequest,
  CreateDepartmentAgentRequest,
  CreateTemplateRequest,
  DepartmentAgent,
  ListAgentPromotionsParams,
  ListDepartmentAgentsParams,
  ListEvalGoldenCasesParams,
  ListEvalGoldenSetsParams,
  ListTemplatesParams,
  ListUsageRecordsParams,
  TestTemplateRequest,
  UpdateDepartmentAgentRequest,
  UpdateTemplateRequest,
} from './types';

export function useTemplates(params?: ListTemplatesParams) {
  return useQuery({ queryKey: agentKeys.list(params), queryFn: () => listTemplates(params), placeholderData: keepPreviousData });
}

/** Detail read: `data.data` is the template, `data.etag` feeds PATCH/test. */
export function useTemplate(id: string) {
  return useQuery({ queryKey: agentKeys.detail(id), queryFn: () => getTemplate(id), enabled: !!id });
}

export function useVersions(id: string) {
  return useQuery({ queryKey: agentKeys.versions(id), queryFn: () => listVersions(id), enabled: !!id });
}

/** Diff of two picked versions; held off until both sides differ. */
export function useVersionDiff(id: string, from: number | null, to: number | null) {
  return useQuery({
    queryKey: agentKeys.diff(id, from ?? 0, to ?? 0),
    queryFn: () => diffVersions(id, from as number, to as number),
    enabled: !!id && from !== null && to !== null && from !== to,
  });
}

export function useUsageStats(id: string) {
  return useQuery({ queryKey: agentKeys.usage(id), queryFn: () => getUsageStats(id), enabled: !!id });
}

export function useUsageAnalytics(promptTemplateId?: string) {
  return useQuery({ queryKey: agentKeys.analytics(promptTemplateId), queryFn: () => getUsageAnalytics(promptTemplateId) });
}

export function useUsageRecords(params?: ListUsageRecordsParams) {
  return useQuery({ queryKey: agentKeys.usageRecords(params), queryFn: () => listUsageRecords(params), placeholderData: keepPreviousData });
}

export function useDepartments() {
  return useQuery({ queryKey: agentKeys.departments(), queryFn: listDepartments });
}

function useInvalidateAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: agentKeys.root });
}

export function useCreateTemplate() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (body: CreateTemplateRequest) => createTemplate(body), onSuccess: invalidate });
}

export function useUpdateTemplate() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateTemplateRequest; etag: string }) => updateTemplate(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteTemplate() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => deleteTemplate(id), onSuccess: invalidate });
}

export function useActivateVersion() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: ({ id, versionNumber }: { id: string; versionNumber: number }) => activateVersion(id, versionNumber),
    onSuccess: invalidate,
  });
}

/**
 * Clinical approval, ported from `/prompt-studio`.
 * Invalidates the whole agents root: an approval flips `status` on the row AND
 * pins a new PromptVersion, so list, detail and versions all go stale.
 */
export function useApproveTemplate() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: ({ id, reason, etag }: { id: string; reason?: string; etag: string }) => approveTemplate(id, reason, etag),
    onSuccess: invalidate,
  });
}

/**
 * Test run ACK (BUG-018): returns immediately with the resolved provider/model
 * plus either the assembled prompt (dry run) or the SMR task to stream. No
 * cache invalidation — nothing is written yet (see `useFinalizeTemplateTest`).
 */
export function useTestTemplate() {
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TestTemplateRequest }) => testTemplate(id, body),
  });
}

/**
 * Persists a completed test run's score/output. This IS the OCC write, so it
 * carries If-Match; its result returns the row's new version. Deliberately no
 * invalidation for the same reason the ack has none — the caller already holds
 * the fresh row.
 */
export function useFinalizeTemplateTest() {
  return useMutation({
    mutationFn: ({ id, taskId, etag, versionNumber }: { id: string; taskId: string; etag: string; versionNumber?: number }) =>
      finalizeTemplateTest(id, taskId, etag, versionNumber),
  });
}

export function useAssignDepartment() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (body: AssignDepartmentRequest) => assignDepartment(body), onSuccess: invalidate });
}

// ---------------------------------------------------------------------------
// DepartmentAgent (TASK-546) — the Agent Catalog rows. A separate root
// (['department-agents']) from the PromptTemplate `agentKeys` above, so
// mutations here never invalidate the unrelated template cache.
// ---------------------------------------------------------------------------

export function useDepartmentAgents(params?: ListDepartmentAgentsParams) {
  return useQuery({
    queryKey: departmentAgentKeys.list(params),
    queryFn: () => listDepartmentAgents(params),
    placeholderData: keepPreviousData,
  });
}

/** Detail read: `data.data` is the agent, `data.etag` feeds the Settings-tab PATCH. */
export function useDepartmentAgent(id: string) {
  return useQuery({ queryKey: departmentAgentKeys.detail(id), queryFn: () => getDepartmentAgent(id), enabled: !!id });
}

function useInvalidateDepartmentAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: departmentAgentKeys.root });
}

export function useCreateDepartmentAgent() {
  const invalidate = useInvalidateDepartmentAgents();
  return useMutation({ mutationFn: (body: CreateDepartmentAgentRequest) => createDepartmentAgent(body), onSuccess: invalidate });
}

export function useUpdateDepartmentAgent() {
  const invalidate = useInvalidateDepartmentAgents();
  return useMutation({
    mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateDepartmentAgentRequest; etag: string }) => updateDepartmentAgent(id, patch, etag),
    onSuccess: invalidate,
  });
}

export function useDeleteDepartmentAgent() {
  const invalidate = useInvalidateDepartmentAgents();
  return useMutation({ mutationFn: (id: string) => deleteDepartmentAgent(id), onSuccess: invalidate });
}

/**
 * Atomic default flip. Optimistically flips `isDefault` across every cached
 * department-agents list page for the affected department (so the grouped
 * list shows exactly one Default badge per department immediately), rolls
 * back on error, and always reconciles with a background invalidate.
 */
export function useSetDefaultDepartmentAgent() {
  const queryClient = useQueryClient();
  // Scoped to the LIST queries only (`[...root, 'list']`) — the broader
  // `root` prefix also matches the detail query, whose cached shape is
  // `WithEtag<DepartmentAgent>` (a single row), not `Paginated<DepartmentAgent>`;
  // running the list updater against it would throw inside onMutate and
  // silently swallow the mutation before the POST ever fires.
  const listQueryKey = [...departmentAgentKeys.root, 'list'] as const;
  return useMutation({
    mutationFn: (id: string) => setDefaultDepartmentAgent(id),
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: listQueryKey });
      const previous = queryClient.getQueriesData<Paginated<DepartmentAgent>>({ queryKey: listQueryKey });
      queryClient.setQueriesData<Paginated<DepartmentAgent>>({ queryKey: listQueryKey }, (data) => {
        if (!data) return data;
        const target = data.data.find((row) => row.id === id);
        if (!target) return data;
        return { ...data, data: data.data.map((row) => (row.departmentId === target.departmentId ? { ...row, isDefault: row.id === id } : row)) };
      });
      return { previous };
    },
    onError: (_error, _id, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: departmentAgentKeys.root }),
  });
}

/** Pin to a specific PromptVersion, or `null` to track the latest APPROVED. */
export function usePinDepartmentAgent() {
  const invalidate = useInvalidateDepartmentAgents();
  return useMutation({
    mutationFn: ({ id, versionNumber }: { id: string; versionNumber: number | null }) => pinDepartmentAgent(id, versionNumber),
    onSuccess: invalidate,
  });
}

/**
 * The department's RESOLVED context schema (TASK-658) — the closed set of
 * kind/output keys the Loop config tab's `subscribedKinds`/`writeScope`
 * pickers offer. Held off until a department is known.
 */
export function useResolvedContextSchema(departmentId: string | undefined) {
  return useQuery({
    queryKey: departmentAgentKeys.contextSchema(departmentId ?? ''),
    queryFn: () => getResolvedContextSchema(departmentId),
    enabled: !!departmentId,
  });
}

/**
 * TASK-674 — the immutable loop-configuration version history (Lineage tab).
 * Newest first, mirroring `useVersions` for `PromptTemplate` above.
 */
export function useDepartmentAgentVersions(id: string) {
  return useQuery({
    queryKey: departmentAgentKeys.versions(id),
    queryFn: () => listDepartmentAgentVersions(id),
    enabled: !!id,
  });
}

/**
 * TASK-674 — promotions INTO the working tenant, filtered to one target
 * agent (the Lineage tab's "promoted from" section). Held off until an agent
 * id is known; the working tenant's own promotion rows are already scoped
 * server-side by the tenant-scope extension.
 */
export function useAgentPromotionsForTarget(targetAgentId: string | undefined) {
  const params: ListAgentPromotionsParams | undefined = targetAgentId ? { targetAgentId, limit: 50 } : undefined;
  return useQuery({
    queryKey: agentPromotionKeys.list(params),
    queryFn: () => listAgentPromotions(params),
    enabled: !!targetAgentId,
  });
}

// ---------------------------------------------------------------------------
// Eval-gated promotion (TASK-549) — golden-set picker + run-now for the
// Governance tab's Eval panel. See client.ts for the rationale on why these
// duplicate (rather than import) the harness-ops feature's own copies.
// ---------------------------------------------------------------------------

/**
 * Golden sets for the Settings-tab picker, the Eval panel's name lookup, and
 * the Test Bench's "Golden case" example-data source. `options.enabled`
 * defers the read until a caller (e.g. the Test Bench) actually needs it.
 */
export function useEvalGoldenSets(params?: ListEvalGoldenSetsParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: agentEvalKeys.goldenSets(params),
    queryFn: () => listEvalGoldenSets(params),
    enabled: options?.enabled ?? true,
  });
}

/**
 * A golden set's cases (PHI-safe metadata) for the Test Bench's "Golden case"
 * combobox — disabled until a golden set is picked.
 */
export function useEvalGoldenCases(goldenSetId: string | null, params?: ListEvalGoldenCasesParams) {
  return useQuery({
    queryKey: agentEvalKeys.goldenCases(goldenSetId ?? '', params),
    queryFn: () => listEvalGoldenCases(goldenSetId as string, params),
    enabled: !!goldenSetId,
    retry: false,
  });
}

/**
 * Runs for ONE golden set (the Eval panel's "last runs" list) — disabled
 * until an agent with an attached golden set is selected.
 */
export function useAgentEvalRuns(goldenSetId: string | null, limit = 5) {
  const params = { goldenSetId: goldenSetId ?? undefined, limit };
  return useQuery({
    queryKey: agentEvalKeys.evalRuns(params),
    queryFn: () => listAgentEvalRuns(params),
    enabled: !!goldenSetId,
  });
}

/** Synchronous manual run-now — invalidates the eval-gated-promotion root so the "last runs" list refetches. */
export function useRunGoldenSetEval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (goldenSetId: string) => runGoldenSetEval(goldenSetId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: agentEvalKeys.root }),
  });
}
