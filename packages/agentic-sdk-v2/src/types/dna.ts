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
// Response Variants
// =============================================================================

/**
 * DNA report with fallback source indicator.
 * Used by getDnaReportWithFallback to indicate where the style came from.
 */
export interface DnaReportWithFallback extends DnaReport {
  fallbackSource: 'doctor' | 'department';
}
