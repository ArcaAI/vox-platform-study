/**
 * Wire types for the AI Operations — Metrics surface.
 * Generation panels consume `GET admin/agent-trajectory/metrics/generation`
 *; regeneration / SLA panels still derive from the
 * harness-admin gate queue. Shapes mirror the gateway DTOs; features never
 * import one another (rule 13), so the subset used here is re-declared rather
 * than shared with the Runs feature.
 */

export type TrajectorySessionKind = 'LIVE_DOC' | 'HARNESS_DOC' | 'SUMMARY_JOB' | 'EVAL_RUN' | string;

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
    kind?: TrajectorySessionKind;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
    [key: string]: string | number | boolean | undefined | null;
}

/** GET /admin/agent-trajectory/metrics/generation query. */
export interface GenerationMetricsParams {
    consultationId?: string;
    from?: string;
    to?: string;
    [key: string]: string | number | boolean | undefined | null;
}

/**
 * GET /admin/agent-trajectory/metrics/generation response
 * (`GenerationMetricsAggregateResponse`).
 */
export interface GenerationAggregateResponse {
    sampleCount: number;
    ttftMedianMs: number | null;
    ttftP95Ms: number | null;
    tokensPerSecondAvg: number | null;
    stopReasons: Array<{ reason: string; count: number }>;
}

/**
 * AD-1 GenerationStats on LLM_CALL steps. Emitters store snake_case; some
 * fixtures/legacy paths use camelCase. Prefer `normalizeGenerationStats`.
 */
export interface GenerationStats {
    ttftMs?: number;
    ttft_ms?: number;
    totalMs?: number;
    total_ms?: number;
    tokensPerSecond?: number;
    tokens_per_second?: number;
    promptTokens?: number;
    prompt_tokens?: number;
    completionTokens?: number;
    completion_tokens?: number;
    predicted_tokens?: number;
    totalTokens?: number;
    total_tokens?: number;
    stopReason?: string;
    stop_reason?: string;
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
    stepType: string;
    name: string;
    status: string;
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

/** GET gate-queue envelope + the effective policy timers. */
export interface GateQueue {
    items: GateQueueItem[];
    total: number;
    slaBreachedCount: number;
    escalatedCount: number;
    gateSlaSeconds: number;
    gateEscalationSeconds: number;
    policySource: 'tenant' | 'system-default' | 'code-default';
}
