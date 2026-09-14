/**
 * @arcaai/vox - DNA Writing Style Types
 *
 * Types for DNA writing style analysis and management.
 * Extends existing DNAStyle/DNAStyleData from summary.ts.
 *
 * Matches WS-2 backend DTOs (DnaWritingStyleService).
 */

import type { DNAStyleData } from './summary';

// =============================================================================
// DNA Report
// =============================================================================

/**
 * Full DNA writing style report from the backend.
 * Represents a doctor's analyzed writing style.
 */
export interface DnaReport {
  id: string;
  doctorId: string;
  departmentId?: string;
  reportData: DnaReportData;
  styleText?: string;
  isLatest: boolean;
  currentVersionNumber: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Row `_version` — the OCC validator, NOT `currentVersionNumber` (which
   * counts the report's content snapshots). `PATCH :reportId/default` requires
   * `If-Match`, so `useDnaStyle.setDefault` echoes this back. Optional: when
   * the SDK holds no version it sends no precondition rather than guessing.
   */
  version?: number;
}

/**
 * DNA report analysis data.
 * Extends the existing DNAStyleData with additional domain-specific fields.
 */
export interface DnaReportData extends DNAStyleData {
  /** Writing formality level descriptor */
  formality?: string;
  /** Sentence length descriptor */
  sentenceLength?: string;
  /** Medical terminology usage frequency */
  medicalTermUsage?: string;
  /** Abbreviation style descriptor */
  abbreviationStyle?: string;
}

// =============================================================================
// DNA Version
// =============================================================================

/**
 * A version snapshot of a DNA writing style report.
 */
export interface DnaStyleVersion {
  id: string;
  dnaReportId: string;
  versionNumber: number;
  reportData: DnaReportData;
  styleText?: string;
  changeReason?: string;
  changedBy?: string;
  createdAt: string;
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Input for generating a new DNA writing style report.
 */
export interface DnaGenerateInput {
  textSamples?: string[];
  departmentId?: string;
  /**
   * IDs of historical source items (e.g. prior report-version
   * snapshots or context items) the doctor selected to seed a fresh generation.
   */
  sourceIds?: string[];
}

/**
 * Input for updating an existing DNA report.
 */
export interface DnaUpdateInput {
  reportData?: Partial<DnaReportData>;
  styleText?: string;
  changeReason?: string;
}

// =============================================================================
// Job Types
// =============================================================================

export interface DnaJobResult {
  reportId: string;
  reportData?: Record<string, unknown>;
  styleText?: string;
}

export interface DnaJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: DnaJobResult;
  error?: string;
}

/**
 * Result of erasing a clinician's learned writing-style profile.
 *
 * Counts only — the erased profile text is PHI-derived and is never echoed
 * back by the gateway.
 */
export interface DnaErasureResult {
  doctorId: string;
  deletedReports: number;
  deletedVersions: number;
}

// =============================================================================
// Response Variants
// =============================================================================

/**
 * DNA report with fallback source indicator.
 * Used by getDnaReportWithFallback to indicate where the style came from.
 */
export interface DnaReportWithFallback extends DnaReport {
  fallbackSource: 'doctor' | 'department';
}

// =============================================================================
// DNA Aggregate Dashboard
// =============================================================================

/** A single day bucket of DNA usage activity. */
export interface DnaDashboardDailyCount {
  /** Day bucket, `YYYY-MM-DD` (UTC). */
  date: string;
  count: number;
}

/** A recent DNA usage record surfaced on the dashboard. */
export interface DnaDashboardUsageEntry {
  id: string;
  doctorId: string;
  dnaReportId: string;
  dnaVersionNumber?: number;
  consultationId?: string;
  createdAt: string;
}

/** Recent DNA usage activity aggregated from `DnaUsageRecord`. */
export interface DnaDashboardRecentActivity {
  /** Per-day usage counts over the window (oldest first). */
  dailyCounts: DnaDashboardDailyCount[];
  /** A few of the most recent usage entries (newest first). */
  latest: DnaDashboardUsageEntry[];
  /** Total usage records within the window. */
  total: number;
  /** Window length in days the activity covers. */
  windowDays: number;
}

/**
 * DNA aggregate dashboard payload returned by
 * `GET /admin/dna-writing-styles/dashboard`.
 */
export interface DnaDashboard {
  /** Count of distinct doctors that have a latest report. */
  usersWithStyle: number;
  /** Average current version number across latest reports. */
  avgVersions: number;
  recentActivity: DnaDashboardRecentActivity;
}

// =============================================================================
// Writing-Sample Ingest (TASK-974, business plane — `POST dna-writing-styles/ingest`)
// =============================================================================

/**
 * The kind of writing sample submitted for DNA analysis. Mirrors the
 * gateway's `IngestDnaWritingSamplesRequest.items[].kind` (README §4.1);
 * default on the wire is `'OTHER'` when omitted.
 */
export type DnaWritingSampleKind = 'CASE_NOTE' | 'WORK_NOTE' | 'OTHER';

/** One item in a time-ordered batch of a clinician's writing samples. */
export interface DnaWritingSample {
  /** 1..20000 chars. */
  text: string;
  /** ISO-8601 date-time — the time-series key the processor sorts on. */
  writtenAt: string;
  /** Defaults to `'OTHER'` on the gateway when omitted. */
  kind?: DnaWritingSampleKind;
  /** Opaque caller reference (≤ 200 chars), explainability only — never echoed back. */
  sourceRef?: string;
}

/**
 * Request body of `POST /dna-writing-styles/ingest`.
 *
 * `clinicianUserId` is REQUIRED for an API-key / service-account caller;
 * for a human JWT caller, absent means "the caller acting as a doctor",
 * present means naming another clinician (SUPER_ADMIN/TENANT_ADMIN only).
 */
export interface DnaWritingSamplesIngestInput {
  clinicianUserId?: string;
  /** 1..200 items; Σ `text` ≤ 400000 chars. */
  items: DnaWritingSample[];
}

/** `202` response of `POST /dna-writing-styles/ingest`. */
export interface DnaIngestJobResponse {
  jobId: string;
  status: 'PENDING';
  clinicianUserId: string;
  acceptedItems: number;
  window: { from: string; to: string };
}

/**
 * `GET /dna-writing-styles/ingest/jobs/:jobId` response — the same
 * `DnaJobStatusResponseDto` shape the gateway already serves for
 * `POST dna-writing-styles/generate` jobs (README §4.1).
 */
export interface DnaIngestJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress?: number;
  result?: DnaJobResult;
  error?: string;
}
