/**
 * Wire types mirroring the DNA writing-style admin surface
 * (DnaWritingStyleAdminController + @arcaai/applications DTOs — the console
 * cannot import those server packages, so the shapes are declared here once).
 */

/** DnaReportResponse. `version` is the OCC row token, NOT the history counter. */
export interface DnaReport {
    id: string;
    doctorId: string;
    /** Human-readable doctor username resolved server-side (DnaReportResponse contract). */
    doctorUsername?: string;
    reportData?: Record<string, unknown>;
    styleText?: string;
    /** Whether this is the doctor's active/latest report. */
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

export interface DnaDashboardDailyCount {
    /** Day bucket (YYYY-MM-DD, UTC). */
    date: string;
    count: number;
}

export interface DnaDashboardUsageEntry {
    id: string;
    doctorId: string;
    dnaReportId: string;
    dnaVersionNumber?: number;
    consultationId?: string;
    createdAt: string;
}

export interface DnaDashboardRecentActivity {
    dailyCounts: DnaDashboardDailyCount[];
    latest: DnaDashboardUsageEntry[];
    /** Total usage records within the window. */
    total: number;
    windowDays: number;
}

/** DnaDashboardResponse — GET /admin/dna-writing-styles/dashboard. */
export interface DnaDashboard {
    /** Distinct doctors that have a latest report. */
    usersWithStyle: number;
    /** Average currentVersionNumber across latest reports. */
    avgVersions: number;
    recentActivity: DnaDashboardRecentActivity;
}

/**
 * List query for GET /admin/dna-writing-styles. UNLIKE the platform-wide
 * zero-based PaginatedQuery, this controller's `page` is ONE-based
 * (`Number(page) || 1`); the response is the standard Paginated envelope.
 */
export interface ListDnaReportsParams {
    /** ONE-based page number (controller default 1). */
    page?: number;
    limit?: number;
    /** Narrow to one doctor (exact id — the endpoint has no text search). */
    doctorId?: string;
    /** Include DISABLED reports (serialized as the literal string "true"). */
    includeDisabled?: boolean;
    [key: string]: string | number | boolean | undefined | null;
}

/** GenerateDnaReportRequest — every field optional; `{}` is a valid body. */
export interface GenerateDnaReportRequest {
    /** Text samples for analysis (gathered from ContextItems when omitted). */
    textSamples?: string[];
    promptTemplateId?: string;
    /** Edited summary text to seed the DNA analysis. */
    editedSummary?: string;
    /** Historical source item ids seeding a generate-from-history run. */
    sourceIds?: string[];
}

/** UpdateDnaReportRequest (admin PATCH — If-Match required, 412 on drift). */
export interface UpdateDnaReportRequest {
    reportData?: Record<string, unknown>;
    styleText?: string;
    changeReason?: string;
    resourceStatus?: 'ENABLED' | 'DISABLED';
    /** Derived from the read ETag by the client; header overrides it server-side. */
    expectedVersion?: number;
}

/** DnaJobResponseDto — POST generate/:doctorId acknowledgement. */
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
