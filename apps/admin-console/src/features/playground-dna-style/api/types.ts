/**
 * Wire types mirroring the DNA writing-style SELF plane
 * (DnaWritingStyleController + @arcaai/applications DTOs — the console cannot
 * import those server packages, so the shapes are declared here once).
 * Deliberately independent from the admin feature's copies: features never
 * import each other (rule 13).
 */

/** DnaReportResponse. `version` is the OCC row token, NOT the history counter. */
export interface DnaReport {
    id: string;
    doctorId: string;
    /** Human-readable doctor username resolved server-side (DnaReportResponse contract). */
    doctorUsername?: string;
    reportData?: Record<string, unknown>;
    styleText?: string;
    /** Whether this is the doctor's active/default report. */
    isLatest: boolean;
    /** Human-meaningful DnaVersion history counter (distinct from `version`). */
    currentVersionNumber: number;
    createdAt: string;
    updatedAt: string;
    resourceStatus?: 'ENABLED' | 'DISABLED';
    /** Row `_version` for If-Match optimistic concurrency (ETag mirrors it). */
    version: number;
}

/** DnaVersionResponse — one row of the report's version timeline. */
export interface DnaVersion {
    id: string;
    dnaReportId: string;
    versionNumber: number;
    reportData?: Record<string, unknown>;
    styleText?: string;
    changeReason?: string;
    changedBy?: string;
    createdAt: string;
}

/** GenerateDnaReportRequest — every field optional; `{}` is a valid body. */
export interface GenerateDnaStyleRequest {
    /** Text samples for analysis (gathered from ContextItems when omitted). */
    textSamples?: string[];
    promptTemplateId?: string;
    /** Edited summary text to seed the DNA analysis. */
    editedSummary?: string;
    /** Historical source item ids seeding a generate-from-history run. */
    sourceIds?: string[];
}

/** UpdateDnaReportRequest (self PATCH — If-Match required, 428/412). */
export interface UpdateMyReportRequest {
    reportData?: Record<string, unknown>;
    styleText?: string;
    changeReason?: string;
    /** Derived from the read ETag by the client; header overrides it server-side. */
    expectedVersion?: number;
}

/**
 * DnaSettingsResponse — the per-doctor DNA on/off settings.
 * `effective = tenantEnabled && (doctorToggle ?? true)`; `version` is the
 * DOCTOR-scope policy row's OCC token (0 when no override row exists yet).
 */
export interface DnaSettings {
    /** The doctor's explicit toggle (null = inherit / implicit opt-in). */
    doctorToggle: boolean | null;
    tenantEnabled: boolean;
    effective: boolean;
    version: number;
}

/** UpdateDnaSettingsRequest — PUT body for the doctor DNA on/off switch. */
export interface UpdateDnaSettingsRequest {
    /** true = opt-in, false = opt-out, null = clear the override. */
    enabled: boolean | null;
    /** Free-text reason recorded on the WORM change row. */
    reason?: string;
    /** Current DOCTOR-row version for OCC (from a prior GET; omit when 0). */
    expectedVersion?: number;
}

/** DnaJobResponseDto — POST generate acknowledgement. */
export interface DnaJob {
    /** BullMQ job id — poll/stream key for progress. */
    jobId: string;
    status: string;
}

export type DnaJobState = 'queued' | 'processing' | 'completed' | 'failed';

/** DnaJobStatusResponseDto — GET jobs/:jobId and the SSE `status` event payload. */
export interface DnaJobStatus {
    jobId: string;
    status: DnaJobState;
    /** 0..100. */
    progress: number;
    /** Present once completed. */
    result?: unknown;
    /** Present once failed. */
    error?: string;
}
