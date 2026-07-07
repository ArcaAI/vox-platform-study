/**
 * Playground consultation wire types (frames 50 + 50.1, matrix row 34) —
 * client subsets of the END-USER consultation plane DTOs, verified against
 * `apps/api/src/modules/consultation/*` + `packages/applications` (TASK-432).
 * This plane has TWO job-state spellings: the async POST replies lowercase
 * (`pending|processing|…`, AsyncJobResponse) while the job status route and
 * its SSE stream reply UPPERCASE (`PENDING|RUNNING|…`, JobStatusResponse) —
 * helpers below fold both.
 */

/** AudioPipelinePublicController `GET audio/pipelines` row (PipelineResponse subset). */
export interface AudioPipeline {
    id: string;
    name: string;
    slug: string;
    description?: string | null;
    isDefault?: boolean;
}

/** ConsultationResponse subset — the demo only reads identity + lifecycle. */
export interface PlaygroundConsultation {
    id: string;
    patientId: string;
    doctorId?: string;
    departmentId?: string | null;
    appointmentDate?: string;
    /** OPEN | RECORDING | PENDING_REVIEW | COMPLETED | CLOSED (gateway enum). */
    status: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface OpenConsultationRequest {
    patientId: string;
    appointmentDate?: string;
    departmentId?: string;
    metadata?: Record<string, unknown>;
}

/** RecordingStateResponse — `POST :id/recording/{start,stop}`. */
export interface RecordingState {
    consultationId: string;
    status: string;
    recording: boolean;
    sessionId?: string;
    /** Gateway-relative live-summary SSE path (informational; see client.ts builders). */
    sseUrl: string;
    updatedAt: string;
}

export interface GenerateSummaryRequest {
    contextItemIds?: string[];
    dnaStyleId?: string;
    template?: string;
    includeNER?: boolean;
    options?: Record<string, unknown>;
    idempotencyKey?: string;
}

/** SummaryResponse — `id` IS the summary's contextItemId (approve path param). */
export interface SummaryResult {
    id: string;
    consultationId: string;
    type: string;
    content: string;
    dnaStyleId?: string | null;
    /** Provenance meta (llmProvider/modelName/processingTimeMs) when present. */
    structuredData?: {
        llmProvider?: string;
        modelName?: string;
        processingTimeMs?: number;
        [key: string]: unknown;
    };
    createdAt?: string;
    updatedAt?: string;
}

/** AsyncJobResponse — `POST :id/summary/async` (lowercase states). */
export interface AsyncSummaryJob {
    jobId: string;
    status: string;
    consultationId?: string;
    createdAt?: string;
    progress?: number;
    result?: unknown;
    errorMessage?: string;
}

/**
 * JobStatusResponse — `GET consultations/jobs/:jobId` and each default SSE
 * `message` on its stream (UPPERCASE states). Kept as the raw wire shape;
 * use {@link isTerminalConsultationJob} / {@link consultationJobStateLabel}
 * instead of comparing `status` casing by hand.
 */
export interface ConsultationJobStatus {
    jobId: string;
    type?: string;
    status: string;
    progress?: number;
    currentStep?: string;
    consultationId?: string;
    result?: unknown;
    error?: string;
    errorMessage?: string;
    createdAt?: string;
    updatedAt?: string;
}

/** True for COMPLETED/FAILED/CANCELLED in either wire spelling. */
export function isTerminalConsultationJob(status: string | null | undefined): boolean {
    const folded = status?.toUpperCase();
    return folded === 'COMPLETED' || folded === 'FAILED' || folded === 'CANCELLED';
}

/** Display label folding both spellings ('processing' and 'RUNNING' → 'Running'). */
export function consultationJobStateLabel(status: string | null | undefined): string {
    switch (status?.toUpperCase()) {
        case 'PENDING':
            return 'Queued';
        case 'PROCESSING':
        case 'RUNNING':
            return 'Running';
        case 'COMPLETED':
            return 'Completed';
        case 'FAILED':
            return 'Failed';
        case 'CANCELLED':
            return 'Cancelled';
        default:
            return 'Unknown';
    }
}

// ─── SSE snapshot shapes (full-state events; clients stay stateless) ───

export interface LiveSummarySection {
    title: string;
    content: string;
}

export interface LiveSummaryEntity {
    text: string;
    type: string;
    confidence?: number;
}

/** LiveSummaryEventDto — scope `consultation_live_summary:<id>`. */
export interface LiveSummarySnapshot {
    consultationId: string;
    runningSummary: string;
    sections: LiveSummarySection[];
    entities: LiveSummaryEntity[];
    updatedAt: string;
    /** Terminal event (recording stopped). */
    closed?: boolean;
}

export type HarnessStageStatus = 'completed' | 'active' | 'pending' | 'failed';

export interface HarnessStage {
    /** extracting_information | assembling_context | drafting_note | running_safety_sensors | finalizing_draft */
    stage: string;
    label: string;
    ordinal: number;
    status: HarnessStageStatus;
    attempt: number;
    at: string;
}

/** HarnessProgressEventDto — scope `consultation_harness_progress:<id>`. */
export interface HarnessProgressSnapshot {
    consultationId?: string;
    total?: number;
    stages: HarnessStage[];
    updatedAt: string;
    closed: boolean;
}

export interface HarnessClaim {
    claimId: string;
    /** groundedness | citation_verify | safety */
    sensor: string;
    verdict: string;
    label?: string;
    ordinal?: number;
    at?: string;
}

/**
 * HarnessAssuranceEventDto — scope `consultation_harness_assurance:<id>`.
 * The terminal NAMED event `assurance_complete` carries the aggregates.
 */
export interface HarnessAssuranceSnapshot {
    consultationId?: string;
    total?: number;
    claims: HarnessClaim[];
    gateDecision?: string;
    safetyFlag?: boolean;
    reducedAssurance?: boolean;
    postSignAlert?: boolean;
    updatedAt: string;
    closed: boolean;
}

/** Two-bucket verdict fold for the review list (PASS chip vs REVIEW chip). */
export function claimVerdictBucket(verdict: string): 'pass' | 'review' {
    switch (verdict.toLowerCase()) {
        case 'pass':
        case 'grounded':
        case 'verified':
        case 'supported':
            return 'pass';
        default:
            return 'review';
    }
}

// ─── Review plane ───

export interface ApproveSummaryRequest {
    overrideSafetyFlag?: boolean;
}

/** SummaryApprovalResponse — `POST :id/summary/:contextItemId/approve`. */
export interface SummaryApproval {
    contextItemId: string;
    approvalStatus: string;
    approvedBy?: string;
    approvedAt?: string;
}

export interface NamedEntityItem {
    id?: string;
    text: string;
    displayText?: string;
    [key: string]: unknown;
}

/** AggregateNerResponse — `GET :id/named-entities?scope=single|chain`. */
export interface NamedEntitiesAggregate {
    consultationId: string;
    scope: string;
    entities: Record<string, NamedEntityItem[]>;
    totalCount: number;
    countByClass: Record<string, number>;
    sources: unknown[];
}
