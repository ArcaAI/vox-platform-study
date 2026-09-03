'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { approveRunGate, getRunGate, getRunTrace, getWorkflowDefinitionVersion, getWorkflowRun, listWorkflowRuns } from './client';
import { workflowRunsKeys } from './keys';
import { RUN_POLL_INTERVAL_MS, isNonTerminalRunStatus, runRefetchInterval, runsListRefetchInterval } from './polling';
import type { ApproveRunGateBody, ListWorkflowRunsParams } from './types';

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

/**
 * The CQRS-lite trace read: run row + per-node rollup in one call.
 *
 * lane C: the primary transport for a LIVE run is the SSE push
 * (`useRunLiveEvents`, `live-events.ts`) re-fetching this query on a control
 * frame — never a fixed interval. `pollAsFallback` mirrors
 * `useTranscriptionJob`'s own documented fallback (`transcription-jobs/api/hooks.ts`):
 * pass it only while the stream sits on `error`, so the screen keeps
 * updating (at the old 5 s cadence) until the stream reconnects or the run
 * settles, rather than going silent.
 */
export function useRunTrace(runId: string | null, pollAsFallback = false) {
  return useQuery({
    queryKey: workflowRunsKeys.trace(runId ?? ''),
    queryFn: () => getRunTrace(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => (pollAsFallback ? runRefetchInterval(query.state.data?.run.status) : false),
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

/**
 * Live HITL-gate state for a run.
 *
 * Polls on the same cadence as the run itself while the run is live, because a run can ENTER
 * its gate at any point during execution — a one-shot read taken when the screen mounted would
 * leave a clinician staring at a run that is silently waiting for them. Stops as soon as the
 * run is terminal, or the gate is no longer waiting.
 */
export function useRunGate(runId: string | null, runStatus: string | null | undefined) {
  return useQuery({
    queryKey: workflowRunsKeys.gate(runId ?? ''),
    queryFn: () => getRunGate(runId as string),
    enabled: !!runId,
    refetchInterval: (query) => {
      if (!isNonTerminalRunStatus(runStatus)) return false;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
      return query.state.data?.waiting === false && query.state.data?.exists === true ? false : RUN_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    // A run without a gate is the common case and its answer never changes; don't hammer it.
    staleTime: 0,
  });
}

/**
 * Release the gate. Invalidates the gate AND the run/trace reads: approving is what un-parks the
 * interpreter, so the run's own status changes moments later.
 */
export function useApproveRunGate(runId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveRunGateBody) => approveRunGate(runId as string, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workflowRunsKeys.gate(runId ?? '') });
      void queryClient.invalidateQueries({ queryKey: workflowRunsKeys.detail(runId ?? '') });
      void queryClient.invalidateQueries({ queryKey: workflowRunsKeys.trace(runId ?? '') });
    },
  });
}
