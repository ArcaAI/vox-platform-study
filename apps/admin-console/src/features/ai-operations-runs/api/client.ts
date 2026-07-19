/**
 * AI Operations — Runs client (TASK-512 screen 1). Gateway-relative paths under
 * the /api/hope BFF proxy. Sessions/steps are the TASK-510 trajectory read
 * plane (@CanManage('HarnessPolicy')); cancel/signal proxy the harness-admin
 * Temporal workflow-ops (manage HarnessWorkflow); the SSE stream is consumed
 * DIRECTLY off the gateway via the shared ticket-authed useEventStream.
 */

import { getJson, postJson } from '@/shared/api';
import type {
    GateQueue,
    ListSessionsParams,
    ListStepsParams,
    SignalWorkflowBody,
    TrajectorySessionsList,
    TrajectoryStepsPage,
    WorkflowActionBody,
    WorkflowActionResult,
} from './types';

const TRAJECTORY = 'admin/agent-trajectory';
const HARNESS = 'admin/harness';

export function listSessions(params?: ListSessionsParams): Promise<TrajectorySessionsList> {
    return getJson(`${TRAJECTORY}/sessions`, params);
}

/** Keyset page of ordered steps (seq asc) for a session. */
export function listSteps(sessionId: string, params?: ListStepsParams): Promise<TrajectoryStepsPage> {
    return getJson(`${TRAJECTORY}/sessions/${encodeURIComponent(sessionId)}/steps`, params);
}

export function getGateQueue(): Promise<GateQueue> {
    return getJson(`${HARNESS}/gate-queue`);
}

/** Graceful cancel of a harness Temporal workflow (sessionId == workflowId for HARNESS_DOC). */
export function cancelWorkflow(workflowId: string, body: WorkflowActionBody): Promise<WorkflowActionResult> {
    return postJson(`${HARNESS}/workflows/${encodeURIComponent(workflowId)}/cancel`, body);
}

export function signalWorkflow(workflowId: string, body: SignalWorkflowBody): Promise<WorkflowActionResult> {
    return postJson(`${HARNESS}/workflows/${encodeURIComponent(workflowId)}/signal`, body);
}

/** SSE relative path (no leading slash) for the shared ticket-authed stream hook. */
export function trajectoryStreamPath(consultationId: string): string {
    return `consultations/${encodeURIComponent(consultationId)}/trajectory/stream`;
}

export function trajectoryStreamScope(consultationId: string): string {
    return `consultation_trajectory:${consultationId}`;
}
