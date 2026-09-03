'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cancelSandboxRun,
  createFixture,
  deleteFixture,
  getRunTrace,
  getSandboxRunStatus,
  listFixtures,
  listWorkflowDefinitions,
  startSandboxRun,
  updateFixture,
} from './client';
import { workbenchKeys } from './keys';
import type { CreateFixtureBody, StartSandboxRunBody, UpdateFixtureBody } from './types';

/** RUNNING is the only non-terminal status the interpreter reports — same set `useRunTrace`
 *  and `features/workflow-runs` poll against. */
function isNonTerminal(status: string | null | undefined): boolean {
  return typeof status === 'string' && status.toUpperCase() === 'RUNNING';
}

const TRACE_POLL_INTERVAL_MS = 3000;

export function useWorkflowDefinitions(params?: { page?: number; limit?: number }) {
  return useQuery({
    queryKey: workbenchKeys.definitions(params),
    queryFn: () => listWorkflowDefinitions(params ?? { limit: 100 }),
  });
}

export function useFixtures(params?: { page?: number; limit?: number }) {
  return useQuery({
    queryKey: workbenchKeys.fixtures(params),
    queryFn: () => listFixtures(params ?? { limit: 100 }),
  });
}

export function useCreateFixture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFixtureBody) => createFixture(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workbenchKeys.root }),
  });
}

export function useUpdateFixture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateFixtureBody }) => updateFixture(id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workbenchKeys.root }),
  });
}

export function useDeleteFixture() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFixture(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workbenchKeys.root }),
  });
}

/** Starting a run is a TanStack mutation (rule 13 §Data & State); live progress after start is
 *  `useEventStream`, not this hook's polling — see `run-panel.tsx`. */
export function useStartSandboxRun() {
  return useMutation({
    mutationFn: ({ definitionId, body }: { definitionId: string; body: StartSandboxRunBody }) => startSandboxRun(definitionId, body),
  });
}

export function useCancelSandboxRun() {
  return useMutation({
    mutationFn: ({ definitionId, runId }: { definitionId: string; runId: string }) => cancelSandboxRun(definitionId, runId),
  });
}

/** One-shot status read — used to seed the run panel before the SSE stream opens, and as the
 *  fallback if the stream never connects. Not the live-progress channel itself. */
export function useSandboxRunStatus(definitionId: string | null, runId: string | null) {
  return useQuery({
    queryKey: workbenchKeys.sandboxRunStatus(definitionId ?? '', runId ?? ''),
    queryFn: () => getSandboxRunStatus(definitionId as string, runId as string),
    enabled: !!definitionId && !!runId,
  });
}

/**
* The per-node inspector's data source — reuses `admin/workflow-runs/:runId/trace`
 * verbatim: a sandbox run is a `WorkflowRun` row like any other. Polls while the
 *  run is live, matching `features/workflow-runs`' own cadence. 
 */
export function useRunTrace(runId: string | null) {
  return useQuery({
    queryKey: workbenchKeys.runTrace(runId ?? ''),
    queryFn: () => getRunTrace(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => (isNonTerminal(query.state.data?.run.status) ? TRACE_POLL_INTERVAL_MS : false),
    refetchIntervalInBackground: false,
  });
}
