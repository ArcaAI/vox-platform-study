'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    cancelWorkflow,
    createGoldenCase,
    createGoldenSet,
    getEditBurden,
    getEvalRun,
    getGateQueue,
    getGoldenSet,
    getHarnessAudit,
    getLiveSession,
    getWorkflow,
    listEvalRuns,
    listGoldenCases,
    listGoldenSets,
    listLiveSessions,
    listWorkflows,
    signalWorkflow,
    terminateWorkflow,
} from './client';
import { harnessOpsKeys } from './keys';
import { workflowRefetchInterval, workflowsRefetchInterval } from './polling';
import type {
    AuditListParams,
    CreateGoldenCaseBody,
    CreateGoldenSetBody,
    EvalRunListParams,
    GoldenCaseListParams,
    GoldenSetListParams,
    SignalWorkflowBody,
    WorkflowActionBody,
    WorkflowListParams,
} from './types';

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

export function useGoldenSets(params?: GoldenSetListParams) {
    return useQuery({ queryKey: harnessOpsKeys.goldenSets(params), queryFn: () => listGoldenSets(params), placeholderData: keepPreviousData });
}

export function useGoldenSet(goldenSetId: string | null) {
    return useQuery({
        queryKey: harnessOpsKeys.goldenSet(goldenSetId ?? ''),
        queryFn: () => getGoldenSet(goldenSetId ?? ''),
        enabled: !!goldenSetId,
    });
}

/** PHI-safe case metadata for one set (no clinical payload is ever returned). */
export function useGoldenCases(goldenSetId: string | null, params?: GoldenCaseListParams) {
    return useQuery({
        queryKey: harnessOpsKeys.goldenCases(goldenSetId ?? '', params),
        queryFn: () => listGoldenCases(goldenSetId ?? '', params),
        enabled: !!goldenSetId,
        placeholderData: keepPreviousData,
    });
}

export function useCreateGoldenSet() {
    const invalidate = useInvalidateHarnessOps();
    return useMutation({ mutationFn: (body: CreateGoldenSetBody) => createGoldenSet(body), onSuccess: invalidate });
}

export function useCreateGoldenCase(goldenSetId: string | null) {
    const invalidate = useInvalidateHarnessOps();
    return useMutation({ mutationFn: (body: CreateGoldenCaseBody) => createGoldenCase(goldenSetId ?? '', body), onSuccess: invalidate });
}

/**
 * Edit-burden lookup for ONE consultation — disabled until the operator submits
 * an id. A 404 (absent OR cross-tenant, per the 404-over-403 posture) is a
 * normal "no telemetry" outcome, so the query must not retry it; the shared
 * test/query defaults already disable retries.
 */
export function useEditBurden(consultationId: string | null) {
    return useQuery({
        queryKey: harnessOpsKeys.editBurden(consultationId ?? ''),
        queryFn: () => getEditBurden(consultationId ?? ''),
        enabled: !!consultationId,
    });
}

/**
 * Live workflow list. Temporal visibility is a snapshot, so the query polls
 * itself (5s) WHILE any loaded row is still RUNNING and the tab is foreground,
 * and stops once everything is terminal — the manual Refresh button stays.
 */
export function useHarnessWorkflows(params?: WorkflowListParams) {
    return useQuery({
        queryKey: harnessOpsKeys.workflows(params),
        queryFn: () => listWorkflows(params),
        placeholderData: keepPreviousData,
        refetchInterval: (query) => workflowsRefetchInterval(query.state.data?.items),
        refetchIntervalInBackground: false,
    });
}

/**
 * Selected-workflow detail — always asks for the loop phase (`?phase=true`) per
 * frame 38's drawer, and polls itself (5s) while its run is live.
 */
export function useHarnessWorkflow(workflowId: string | null) {
    return useQuery({
        queryKey: harnessOpsKeys.workflow(workflowId ?? ''),
        queryFn: () => getWorkflow(workflowId ?? '', { phase: true }),
        enabled: !!workflowId,
        refetchInterval: (query) => workflowRefetchInterval(query.state.data?.status),
        refetchIntervalInBackground: false,
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

/** Mutations refetch the whole harness-ops branch (lists + any open detail). */
function useInvalidateHarnessOps() {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: harnessOpsKeys.root });
}

export function useSignalWorkflow() {
    const invalidate = useInvalidateHarnessOps();
    return useMutation({
        mutationFn: ({ workflowId, body }: { workflowId: string; body: SignalWorkflowBody }) => signalWorkflow(workflowId, body),
        onSuccess: invalidate,
    });
}

export function useCancelWorkflow() {
    const invalidate = useInvalidateHarnessOps();
    return useMutation({
        mutationFn: ({ workflowId, body }: { workflowId: string; body?: WorkflowActionBody }) => cancelWorkflow(workflowId, body),
        onSuccess: invalidate,
    });
}

export function useTerminateWorkflow() {
    const invalidate = useInvalidateHarnessOps();
    return useMutation({
        mutationFn: ({ workflowId, body }: { workflowId: string; body?: WorkflowActionBody }) => terminateWorkflow(workflowId, body),
        onSuccess: invalidate,
    });
}
