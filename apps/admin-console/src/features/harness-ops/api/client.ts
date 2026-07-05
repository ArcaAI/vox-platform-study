/** Harness observability + workflow ops (capabilities-matrix rows 30–31). */

import { getJson, postJson } from '@/shared/api';
import type {
    AuditListParams,
    EvalRunDetail,
    EvalRunList,
    EvalRunListParams,
    GateQueue,
    HarnessAuditList,
    HarnessWorkflowActionResult,
    HarnessWorkflowDetail,
    HarnessWorkflowList,
    LiveSessionStats,
    LiveSessionsList,
    SignalWorkflowBody,
    WorkflowActionBody,
    WorkflowListParams,
} from './types';

const HARNESS = 'admin/harness';

const workflowPath = (workflowId: string) => `${HARNESS}/workflows/${encodeURIComponent(workflowId)}`;

/** Newest-first WORM audit page + the chain-global integrity verdict. */
export function getHarnessAudit(params?: AuditListParams): Promise<HarnessAuditList> {
    return getJson(`${HARNESS}/audit`, params);
}

/** NOTE: `page` is 1-based on this endpoint (unlike the platform's 0-based lists). */
export function listEvalRuns(params?: EvalRunListParams): Promise<EvalRunList> {
    return getJson(`${HARNESS}/eval-runs`, params);
}

export function getEvalRun(evalRunId: string): Promise<EvalRunDetail> {
    return getJson(`${HARNESS}/eval-runs/${encodeURIComponent(evalRunId)}`);
}

export function getGateQueue(): Promise<GateQueue> {
    return getJson(`${HARNESS}/gate-queue`);
}

/** Temporal visibility list — cursor-paginated via `pageToken`. */
export function listWorkflows(params?: WorkflowListParams): Promise<HarnessWorkflowList> {
    return getJson(`${HARNESS}/workflows`, params);
}

export function getWorkflow(workflowId: string, params?: { phase?: boolean }): Promise<HarnessWorkflowDetail> {
    return getJson(workflowPath(workflowId), params?.phase ? { phase: true } : undefined);
}

export function signalWorkflow(workflowId: string, body: SignalWorkflowBody): Promise<HarnessWorkflowActionResult> {
    return postJson(`${workflowPath(workflowId)}/signal`, body);
}

/** Body is always a JSON object — the gateway's strict ValidationPipe rejects an absent body. */
export function cancelWorkflow(workflowId: string, body: WorkflowActionBody = {}): Promise<HarnessWorkflowActionResult> {
    return postJson(`${workflowPath(workflowId)}/cancel`, body);
}

export function terminateWorkflow(workflowId: string, body: WorkflowActionBody = {}): Promise<HarnessWorkflowActionResult> {
    return postJson(`${workflowPath(workflowId)}/terminate`, body);
}

export function listLiveSessions(): Promise<LiveSessionsList> {
    return getJson(`${HARNESS}/live/sessions`);
}

/** One session's latest PHI-safe stats snapshot (404 when absent or expired). */
export function getLiveSession(consultationId: string): Promise<LiveSessionStats> {
    return getJson(`${HARNESS}/live/sessions/${encodeURIComponent(consultationId)}`);
}
