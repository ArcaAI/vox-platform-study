/**
 * Wire types for the harness admin surface (`/admin/harness/*`, TASK-330
 * Phase 6), mirroring the gateway DTOs in @arcaai/applications
 * (harness-observability + live-doc-admin) and the HarnessOpsClient
 * projections in apps/api. `?tenantId=` exists on every read but is
 * platform-only — the console never sends it (the BFF proxy scopes via
 * X-Tenant-Id).
 */

/** HarnessAuditAction enum (packages/domains). */
export type HarnessAuditAction =
    | 'GENERATE'
    | 'SENSOR_RUN'
    | 'GATE_DECISION'
    | 'ATTEST'
    | 'CONSENT_GIVEN'
    | 'CONSENT_WITHDRAWN'
    | 'BREACH_REPORTED'
    | 'REDUCED_ASSURANCE'
    | 'SAFETY_OVERRIDE'
    | 'SIGNED_BEFORE_ASSURANCE'
    | 'POST_SIGN_FLAG';

/** One WORM audit row (HarnessAuditEventResponse) — append-only, hash-chained. */
export interface HarnessAuditEvent {
    id: string;
    tenantId: string;
    consultationId: string;
    contextItemVersionId: string | null;
    action: HarnessAuditAction;
    modelName: string;
    modelVersion: string;
    promptTemplateId: string | null;
    promptVersion: string | null;
    sensorScores: unknown;
    citations: unknown;
    gateDecision: string | null;
    clinicianId: string | null;
    attestationHash: string | null;
    prevHash: string;
    hash: string;
    createdAt: string;
    createdBy: string | null;
}

/** Chain-global integrity verdict (HarnessAuditVerificationResponse). */
export interface HarnessAuditVerification {
    /** True when the full tenant chain re-verified (hash + prevHash linkage). */
    valid: boolean;
    brokenAtIndex: number | null;
    reason?: string | null;
}

/** GET audit envelope: newest-first page + whole-chain verdict. */
export interface HarnessAuditList {
    items: HarnessAuditEvent[];
    /** Events matching the filter across all pages. */
    total: number;
    verification: HarnessAuditVerification;
}

/** GET audit query — offset-paginated (limit 1–200, default 50). */
export interface AuditListParams {
    consultationId?: string;
    action?: HarnessAuditAction | string;
    /** Inclusive ISO-8601 bounds on createdAt. */
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
    [key: string]: string | number | boolean | undefined | null;
}

/** One eval run (EvalRunResponse). `aggregateScores` is free-form JSON. */
export interface EvalRun {
    id: string;
    tenantId: string;
    goldenSetId: string;
    modelName: string;
    modelVersion: string | null;
    promptTemplateId: string | null;
    promptVersion: string | null;
    judgeModel: string | null;
    status: string | null;
    startedAt: string | null;
    completedAt: string | null;
    aggregateScores: unknown;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
}

/** One per-case metric score (EvalScoreResponse). */
export interface EvalScore {
    id: string;
    tenantId: string;
    evalRunId: string;
    goldenCaseId: string;
    metric: string;
    score: number;
    maxScore: number | null;
    rationale: string | null;
    judgeModel: string | null;
    details: unknown;
    createdAt: string;
}

/** GET eval-runs/:id — the run plus its per-case scores. */
export interface EvalRunDetail extends EvalRun {
    scores: EvalScore[];
}

export interface EvalRunList {
    items: EvalRun[];
    total: number;
}

/** GET eval-runs query — NOTE: `page` is 1-based on this endpoint. */
export interface EvalRunListParams {
    goldenSetId?: string;
    page?: number;
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

/** Temporal status projected by the harness admin surface. */
export type HarnessWorkflowStatus =
    | 'RUNNING'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELED'
    | 'TERMINATED'
    | 'TIMED_OUT'
    | 'CONTINUED_AS_NEW'
    | string;

/** A workflow summary row (HarnessWorkflowSummary in apps/api). */
export interface HarnessWorkflowSummary {
    workflowId: string;
    runId: string | null;
    consultationId: string | null;
    tenantId: string | null;
    status: HarnessWorkflowStatus;
    /** Harness loop phase (NER | ASSEMBLE | GENERATE | SENSORS | GATE) when reported. */
    phase: string | null;
    startedAt: string | null;
    closeTime: string | null;
    regenCount: number | null;
    escalations: number | null;
    slaSeconds: number | null;
}

/** GET workflows envelope — Temporal visibility is cursor-paginated. */
export interface HarnessWorkflowList {
    items: HarnessWorkflowSummary[];
    nextPageToken: string | null;
}

export interface WorkflowListParams {
    status?: string;
    consultationId?: string;
    limit?: number;
    pageToken?: string;
    [key: string]: string | number | boolean | undefined | null;
}

/** GET workflows/:id — full description (no first-class history-event list). */
export interface HarnessWorkflowDetail extends HarnessWorkflowSummary {
    historyLength: number | null;
    pendingActivities: unknown[] | null;
    memo: Record<string, unknown> | null;
    searchAttributes: Record<string, unknown> | null;
    result: unknown;
}

/** POST :id/signal body (SignalWorkflowRequest) — payload must be a JSON object. */
export interface SignalWorkflowBody {
    signalName: string;
    payload?: Record<string, unknown>;
}

/** POST :id/cancel and :id/terminate body (WorkflowActionRequest). */
export interface WorkflowActionBody {
    reason?: string;
}

/** Acknowledgement of a signal/cancel/terminate (HarnessWorkflowActionResult). */
export interface HarnessWorkflowActionResult {
    workflowId: string;
    runId: string | null;
    status: string;
    action: 'cancel' | 'terminate' | 'signal';
    requested: boolean;
}

/** PHI-safe per-session live-doc stats (LiveDocSessionStatsResponse) — sizes/latencies only. */
export interface LiveSessionStats {
    consultationId: string;
    tenantId: string;
    sessionId?: string;
    startedAt: string;
    lastUpdatedAt: string;
    flushCount: number;
    generation: number;
    smrLatencyMs: number;
    nlpLatencyMs: number;
    smrFailed: boolean;
    nlpFailed: boolean;
    staleDropCount: number;
    entityCount: number;
    sectionCount: number;
    summaryChars: number;
}

/** GET live/sessions envelope (no max-session field on the DTO). */
export interface LiveSessionsList {
    items: LiveSessionStats[];
    total: number;
}
