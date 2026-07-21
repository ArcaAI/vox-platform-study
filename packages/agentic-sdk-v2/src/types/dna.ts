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
