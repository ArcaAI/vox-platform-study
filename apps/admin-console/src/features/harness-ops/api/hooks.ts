'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    cancelWorkflow,
    getEvalRun,
    getGateQueue,
    getHarnessAudit,
    getLiveSession,
    getWorkflow,
    listEvalRuns,
    listLiveSessions,
    listWorkflows,
    signalWorkflow,
    terminateWorkflow,
} from './client';
import { harnessOpsKeys } from './keys';
import type { AuditListParams, EvalRunListParams, SignalWorkflowBody, WorkflowActionBody, WorkflowListParams } from './types';

export function useHarnessAudit(params?: AuditListParams) {
    return useQuery({ queryKey: harnessOpsKeys.audit(params), queryFn: () => getHarnessAudit(params), placeholderData: keepPreviousData });
}

export function useEvalRuns(params?: EvalRunListParams) {
    return useQuery({ queryKey: harnessOpsKeys.evalRuns(params), queryFn: () => listEvalRuns(params), placeholderData: keepPreviousData });
}

export function useEvalRun(evalRunId: string | null) {
    return useQuery({
        queryKey: harnessOpsKeys.evalRun(evalRunId ?? ''),
        queryFn: () => getEvalRun(evalRunId ?? ''),
        enabled: !!evalRunId,
    });
}

export function useGateQueue() {
    return useQuery({ queryKey: harnessOpsKeys.gateQueue(), queryFn: getGateQueue });
}

export function useHarnessWorkflows(params?: WorkflowListParams) {
    return useQuery({ queryKey: harnessOpsKeys.workflows(params), queryFn: () => listWorkflows(params), placeholderData: keepPreviousData });
}

/** Detail always asks for the loop phase (`?phase=true`) per frame 38's drawer. */
export function useHarnessWorkflow(workflowId: string | null) {
    return useQuery({
        queryKey: harnessOpsKeys.workflow(workflowId ?? ''),
        queryFn: () => getWorkflow(workflowId ?? '', { phase: true }),
        enabled: !!workflowId,
    });
}

export function useLiveSessions() {
    return useQuery({ queryKey: harnessOpsKeys.liveSessions(), queryFn: listLiveSessions });
}

export function useLiveSession(consultationId: string | null) {
    return useQuery({
        queryKey: harnessOpsKeys.liveSession(consultationId ?? ''),
        queryFn: () => getLiveSession(consultationId ?? ''),
        enabled: !!consultationId,
    });
}

/** Workflow lifecycle mutations refetch the whole workflows branch (list + detail). */
function useInvalidateWorkflows() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: harnessOpsKeys.root });
}

export function useSignalWorkflow() {
    const invalidate = useInvalidateWorkflows();
    return useMutation({
        mutationFn: ({ workflowId, body }: { workflowId: string; body: SignalWorkflowBody }) => signalWorkflow(workflowId, body),
        onSuccess: invalidate,
    });
}

export function useCancelWorkflow() {
    const invalidate = useInvalidateWorkflows();
    return useMutation({
        mutationFn: ({ workflowId, body }: { workflowId: string; body?: WorkflowActionBody }) => cancelWorkflow(workflowId, body),
        onSuccess: invalidate,
    });
}

export function useTerminateWorkflow() {
    const invalidate = useInvalidateWorkflows();
    return useMutation({
        mutationFn: ({ workflowId, body }: { workflowId: string; body?: WorkflowActionBody }) => terminateWorkflow(workflowId, body),
        onSuccess: invalidate,
    });
}
