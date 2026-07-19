'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cancelWorkflow, getGateQueue, listSessions, listSteps, signalWorkflow } from './client';
import { aiRunsKeys } from './keys';
import type { ListSessionsParams, SignalWorkflowBody, WorkflowActionBody } from './types';

export function useSessions(params?: ListSessionsParams) {
    return useQuery({ queryKey: aiRunsKeys.sessions(params), queryFn: () => listSessions(params) });
}

/** Keyset-paginated steps for one session (seq asc). runId "" = non-Temporal stream. */
export function useSteps(sessionId: string | null, runId: string, enabled = true) {
    return useInfiniteQuery({
        queryKey: aiRunsKeys.steps(sessionId ?? '', runId),
        queryFn: ({ pageParam }) =>
            listSteps(sessionId as string, { cursor: pageParam || undefined, ...(runId ? { runId } : {}), limit: 50 }),
        initialPageParam: '',
        getNextPageParam: (lastPage) => (lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined),
        enabled: enabled && !!sessionId,
    });
}

export function useGateQueue(enabled = true) {
    return useQuery({ queryKey: aiRunsKeys.gateQueue(), queryFn: getGateQueue, enabled });
}

export function useCancelWorkflow() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ workflowId, reason }: { workflowId: string; reason?: string }) => cancelWorkflow(workflowId, { reason } as WorkflowActionBody),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: aiRunsKeys.root }),
    });
}

export function useSignalWorkflow() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ workflowId, body }: { workflowId: string; body: SignalWorkflowBody }) => signalWorkflow(workflowId, body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: aiRunsKeys.root }),
    });
}
