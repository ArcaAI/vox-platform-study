'use client';

import { useQuery } from '@tanstack/react-query';
import { getRunTrace, getWorkflowDefinitionVersion, getWorkflowRun, listWorkflowRuns } from './client';
import { workflowRunsKeys } from './keys';
import { runRefetchInterval, runsListRefetchInterval } from './polling';
import type { ListWorkflowRunsParams } from './types';

export function useWorkflowRuns(params?: ListWorkflowRunsParams) {
  return useQuery({
    queryKey: workflowRunsKeys.list(params),
    queryFn: () => listWorkflowRuns(params),
    refetchInterval: (query) => runsListRefetchInterval(query.state.data?.data),
    refetchIntervalInBackground: false,
  });
}

export function useWorkflowRun(runId: string | null) {
  return useQuery({
    queryKey: workflowRunsKeys.detail(runId ?? ''),
    queryFn: () => getWorkflowRun(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => runRefetchInterval(query.state.data?.status),
    refetchIntervalInBackground: false,
  });
}

/** The CQRS-lite trace read: run row + per-node rollup in one call (Task 5). */
export function useRunTrace(runId: string | null) {
  return useQuery({
    queryKey: workflowRunsKeys.trace(runId ?? ''),
    queryFn: () => getRunTrace(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => runRefetchInterval(query.state.data?.run.status),
    refetchIntervalInBackground: false,
  });
}

/** The run's pinned, immutable definition version — published rows never change, so no polling. */
export function useWorkflowDefinitionVersion(workflowVersionId: string | null) {
  return useQuery({
    queryKey: workflowRunsKeys.definitionVersion(workflowVersionId ?? ''),
    queryFn: () => getWorkflowDefinitionVersion(workflowVersionId as string),
    enabled: !!workflowVersionId,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
