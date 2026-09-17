'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activateAgent,
  cloneAgent,
  createAgent,
  createAgentAssignment,
  deleteAgent,
  deprecateAgent,
  exportAgent,
  finalizeAgentTest,
  getAgent,
  getAgentLineageBySlug,
  importAgent,
  listAgentAssignments,
  listAgentLineages,
  listAgentVersions,
  listAgents,
  listDepartments,
  newAgentVersion,
  publishAgent,
  removeAgentAssignment,
  testAgent,
  updateAgent,
  updateAgentAssignment,
  validateAgent,
} from './client';
import type { AgentLineageListParams } from './client';
import { agentKeys } from './keys';
import type {
  AgentLineage,
  AgentTask,
  CloneAgentRequest,
  CreateAgentRequest,
  FinalizeAgentTestRequest,
  ImportAgentRequest,
  NewAgentVersionRequest,
  PublishAgentRequest,
  TestAgentRequest,
  UpdateAgentRequest,
  UpsertAgentAssignmentRequest,
} from './types';

export function useAgents(task?: AgentTask) {
  return useQuery({ queryKey: agentKeys.list(task), queryFn: () => listAgents(task) });
}

/**
 * TASK-965 — the grid's read: one row per LINEAGE, server-paged. `keepPreviousData` so paging or
 * re-filtering keeps the last page on screen (the grid's `isBusy` says it is refreshing) instead
 * of flashing the skeleton — the pattern `useModelsPaginated` established.
 */
export function useAgentLineages(params?: AgentLineageListParams) {
  return useQuery({ queryKey: agentKeys.lineages(params), queryFn: () => listAgentLineages(params), placeholderData: keepPreviousData });
}

/**
 * The deep-link resolver: a `/agents?slug=…` link can name a lineage that is not on the page the
 * grid loaded, so the drawer falls back to this ONE-row read. `enabled` is the caller's, because
 * the screen already holds the row when it came from the open page.
 */
export function useAgentLineageBySlug(slug: string | null, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: agentKeys.lineageBySlug(slug ?? ''),
    queryFn: () => getAgentLineageBySlug(slug as string),
    enabled: !!slug && (options?.enabled ?? true),
  });
}

export function useAgent(id: string | null) {
  return useQuery({ queryKey: agentKeys.detail(id ?? ''), queryFn: () => getAgent(id as string), enabled: !!id });
}

export function useAgentVersions(id: string | null) {
  return useQuery({ queryKey: agentKeys.versions(id ?? ''), queryFn: () => listAgentVersions(id as string), enabled: !!id });
}

/**
 * TASK-965 — every version of ONE lineage, for the drawer's Versions tab.
 *
 * `GET admin/agents/{id}/versions` is addressed by a version ROW ID, not by the slug, and the
 * lineage row carries an id only for its ACTIVE version and its OPEN DRAFT. A lineage whose
 * versions are all published-but-inactive, or all deprecated, therefore has no anchor id on the
 * wire at all — and that is precisely the lineage an admin opens in order to ACTIVATE one. The
 * fallback is the per-version list route (narrowed by task, folded to this slug here), which is
 * what the screen read before the register existed. Remove it the day the register carries a
 * version id of its own, or the versions route accepts a slug.
 */
export function useAgentLineageVersions(lineage: AgentLineage | null) {
  const anchorId = lineage?.active?.id ?? lineage?.draft?.id ?? null;
  const slug = lineage?.slug ?? null;
  const task = lineage?.task;
  return useQuery({
    queryKey: [...agentKeys.root, 'lineage-versions', slug ?? '', anchorId ?? ''] as const,
    queryFn: async () => {
      if (anchorId) return listAgentVersions(anchorId);
      const all = await listAgents(task);
      return all.filter((row) => row.slug === slug);
    },
    enabled: !!slug,
  });
}

export function useAgentAssignments(task?: AgentTask) {
  return useQuery({ queryKey: agentKeys.assignments(task), queryFn: () => listAgentAssignments(task) });
}

export function useDepartments() {
  return useQuery({ queryKey: agentKeys.departments(), queryFn: listDepartments, staleTime: 60_000 });
}

function useInvalidateAgents() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: agentKeys.root });
}

export function useCreateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (body: CreateAgentRequest) => createAgent(body), onSuccess: invalidate });
}

export function useUpdateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, patch, etag }: { id: string; patch: UpdateAgentRequest; etag: string }) => updateAgent(id, patch, etag), onSuccess: invalidate });
}

export function useDeleteAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => deleteAgent(id), onSuccess: invalidate });
}

export function useValidateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => validateAgent(id), onSuccess: invalidate });
}

export function usePublishAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body?: PublishAgentRequest }) => publishAgent(id, body ?? {}), onSuccess: invalidate });
}

export function useNewAgentVersion() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body?: NewAgentVersionRequest }) => newAgentVersion(id, body ?? {}), onSuccess: invalidate });
}

export function useDeprecateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => deprecateAgent(id), onSuccess: invalidate });
}

/**
 * TASK-965 (OD-965-1) — rollback. The invalidation is the whole point: activating vN demotes its
 * sibling server-side, so the lineage register, the version list and every open detail read are
 * all stale the moment it returns. `useInvalidateAgents` drops the whole `agent-entities`
 * namespace, which is exactly the blast radius of a moved pointer.
 */
export function useActivateAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (id: string) => activateAgent(id), onSuccess: invalidate });
}

// TASK-884 — portability. Export is a MUTATION rather than a query on purpose: it is an action
// a person takes (a download), not state the screen renders, so it must not be cached, refetched
// on focus, or run because a drawer opened.
export function useExportAgent() {
  return useMutation({ mutationFn: ({ slug, versionNumber }: { slug: string; versionNumber?: number }) => exportAgent(slug, versionNumber) });
}

export function useCloneAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ slug, body }: { slug: string; body: CloneAgentRequest }) => cloneAgent(slug, body), onSuccess: invalidate });
}

export function useImportAgent() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: (body: ImportAgentRequest) => importAgent(body), onSuccess: invalidate });
}

export function useUpsertAgentAssignment() {
  const invalidate = useInvalidateAgents();
  return useMutation({
    mutationFn: ({ body, etag }: { body: UpsertAgentAssignmentRequest; etag?: string }) => (etag ? updateAgentAssignment(body, etag).then((r) => r.data) : createAgentAssignment(body)),
    onSuccess: invalidate,
  });
}

export function useRemoveAgentAssignment() {
  const invalidate = useInvalidateAgents();
  return useMutation({ mutationFn: ({ id, version, reason }: { id: string; version: number; reason?: string }) => removeAgentAssignment(id, version, reason), onSuccess: invalidate });
}

// TASK-890 §3.8 — the draft-agent test bench. Neither mutation invalidates the agent list: a
// test run touches nothing on the row (findings, tokens, output are all ephemeral to the call).

export function useTestAgent() {
  return useMutation({ mutationFn: ({ id, body }: { id: string; body?: TestAgentRequest }) => testAgent(id, body) });
}

export function useFinalizeAgentTest() {
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: FinalizeAgentTestRequest }) => finalizeAgentTest(id, body) });
}
