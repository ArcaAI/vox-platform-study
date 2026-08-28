'use client';

/**
 * TanStack Query v5 hooks for the agents surface. Mutations invalidate the
 * whole ['agents'] namespace — an admin console prefers fresh reads over
 * cache cleverness (rule 13). The deliberate exceptions: useTestTemplate and
 * useFinalizeTemplateTest invalidate NOTHING — the ack writes nothing at all,
 * and the finalize result carries the row's new OCC version directly.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateVersion,
  approveTemplate,
  assignDepartment,
  createTemplate,
  deleteTemplate,
  diffVersions,
  finalizeTemplateTest,
  getTemplate,
  getUsageAnalytics,
  getUsageStats,
  listAgentEvalRuns,
  listDepartments,
  listEvalGoldenCases,
  listEvalGoldenSets,
  listTemplates,
  listUsageRecords,
  listVersions,
  runGoldenSetEval,
  testTemplate,
  updateTemplate,
} from './client';
import { agentEvalKeys, agentKeys } from './keys';
import type {
  AssignDepartmentRequest,
  CreateTemplateRequest,
  ListEvalGoldenCasesParams,
  ListEvalGoldenSetsParams,
  ListTemplatesParams,
  ListUsageRecordsParams,
  TestTemplateRequest,
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
 * plus either the assembled prompt (dry run) or the TEXT task to stream. No
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
// DepartmentAgent — the Agent Catalog rows. A separate root
// (['department-agents']) from the PromptTemplate `agentKeys` above, so
// mutations here never invalidate the unrelated template cache.
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
