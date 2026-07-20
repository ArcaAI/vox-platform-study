/**
 * Wire types for the AI Operations — Runs surface. Shapes
 * mirror the gateway DTOs in @arcaai/applications (AgentTrajectory* — )
 * plus the harness-admin gate-queue + workflow-ops projections. The console
 * cannot import the server package, so they are re-declared here; features
 * never import one another (rule 13).
 */

export type TrajectorySessionKind = 'LIVE_DOC' | 'HARNESS_DOC' | 'SUMMARY_JOB' | 'EVAL_RUN' | string;
export type TrajectoryStepType =
    | 'LLM_CALL'
    | 'TOOL_CALL'
    | 'SENSOR'
    | 'RETRIEVAL'
    | 'GUARDRAIL'
    | 'THINKING'
    | 'SIGNAL'
    | 'GATE'
    | 'PHASE'
    | string;
export type TrajectoryStepStatus = 'STARTED' | 'OK' | 'ERROR' | 'SKIPPED' | 'TIMEOUT' | string;

/** GET /admin/agent-trajectory/sessions row (AgentTrajectorySessionResponse). */
export interface TrajectorySession {
    sessionId: string;
    /** Empty-string sentinel for non-Temporal sessions. */
    runId: string;
    sessionKind: TrajectorySessionKind;
    consultationId: string | null;
    stepCount: number;
    firstStepAt: string;
    lastStepAt: string;
}

export interface TrajectorySessionsList {
    items: TrajectorySession[];
    total: number;
}

export interface ListSessionsParams {
    consultationId?: string;
    kind?: TrajectorySessionKind;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
    [key: string]: string | number | boolean | undefined | null;
}

/**
 * AD-1 GenerationStats attached to LLM_CALL steps (free-form JsonValue on the
 * wire). All fields optional — the panel renders whichever the harness emitted.
 */
export interface GenerationStats {
    ttftMs?: number;
    totalMs?: number;
    tokensPerSecond?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    stopReason?: string;
    provider?: string;
    model?: string;
    [key: string]: unknown;
}

/** GET :sessionId/steps row (AgentTrajectoryStepResponse). `payloadRef` is never exposed. */
export interface TrajectoryStep {
    id: string;
    tenantId: string;
    consultationId: string | null;
    sessionKind: TrajectorySessionKind;
    sessionId: string;
    runId: string;
    seq: number;
    stepType: TrajectoryStepType;
    name: string;
    status: TrajectoryStepStatus;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    stats: GenerationStats | null;
    errorCode: string | null;
    correlationId: string | null;
    createdAt: string;
}

/** GET :sessionId/steps keyset page (AgentTrajectoryStepsPageResponse). */
export interface TrajectoryStepsPage {
    items: TrajectoryStep[];
    nextCursor: string | null;
    hasMore: boolean;
    limit: number;
}

export interface ListStepsParams {
    runId?: string;
    cursor?: string;
    limit?: number;
    [key: string]: string | number | boolean | undefined | null;
}

/** One consultation awaiting clinician review (GateQueueItemResponse). */
export interface GateQueueItem {
    consultationId: string;
    status: string;
    pendingSince: string;
    ageSeconds: number;
    generateCount: number;
    regenCount: number;
    slaDueAt: string;
    escalationDueAt: string;
    slaBreached: boolean;
    escalated: boolean;
}

/** GET gate-queue envelope (unpaginated) + the effective policy timers. */
export interface GateQueue {
    items: GateQueueItem[];
    total: number;
    slaBreachedCount: number;
    escalatedCount: number;
    gateSlaSeconds: number;
    gateEscalationSeconds: number;
    policySource: 'tenant' | 'system-default' | 'code-default';
}

/** POST workflows/:id/cancel|terminate body (WorkflowActionRequest). */
export interface WorkflowActionBody {
    reason?: string;
}

/** POST workflows/:id/signal body (SignalWorkflowRequest). */
export interface SignalWorkflowBody {
    signalName: string;
    payload?: Record<string, unknown>;
}

/** Acknowledgement of a cancel/terminate/signal (HarnessWorkflowActionResult). */
export interface WorkflowActionResult {
    workflowId: string;
    runId: string | null;
    status: string;
    action: 'cancel' | 'terminate' | 'signal';
    requested: boolean;
}
