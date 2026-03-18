/**
 * @arcaai/vox - Summary Types
 *
 * Types for summary generation and DNA writing style.
 */

// =============================================================================
// Summary Types
// =============================================================================

/**
 * A single named entity extracted via NER.
 */
export interface NEREntity {
  /** The text span of the entity as it appears in the transcript */
  text: string;
  /** Classification label (e.g. MEDICATION, CONDITION, PROCEDURE) */
  label: string;
  /** Confidence score from the NER model, 0-1 */
  confidence?: number;
  /** Character offset start position in the source text */
  startOffset?: number;
  /** Character offset end position in the source text */
  endOffset?: number;
}

/**
 * Summary response from generation
 */
export interface SummaryResponse {
  /** Summary ID */
  id: string;
  /** Associated context item ID */
  contextItemId: string;
  /** Summary content */
  content: string;
  /** Summary type */
  type: 'summary' | 'pre_summary';
  /** LLM provider used */
  llmProvider: string;
  /** Model name used */
  modelName: string;
  /** Processing time in milliseconds */
  processingTimeMs?: number;
  /** DNA style ID if used */
  dnaStyleId?: string;
  /** Named entities extracted when includeNER was true */
  entities?: NEREntity[];
  /** Creation timestamp */
  createdAt: string;
}

// =============================================================================
// DNA Writing Style
// =============================================================================

/**
 * DNA Writing Style
 * Represents a doctor's personalized writing style
 */
export interface DNAStyle {
  /** Style ID */
  id: string;
  /** Style name */
  name: string;
  /** Style description */
  description?: string;
  /** Style data (analysis results) */
  styleData: DNAStyleData;
  /** User ID this style belongs to */
  userId?: string;
  /** Creation timestamp */
  createdAt?: string;
}

/**
 * DNA style analysis data
 */
export interface DNAStyleData {
  /** Average sentence length */
  avgSentenceLength?: number;
  /** Vocabulary complexity score */
  vocabularyComplexity?: number;
  /** Formality level (0-1) */
  formalityLevel?: number;
  /** Common phrases */
  commonPhrases?: string[];
  /** Preferred abbreviations */
  abbreviations?: string[];
  /** Section ordering preferences */
  sectionOrder?: string[];
  /** Raw analysis data */
  raw?: Record<string, unknown>;
}

// =============================================================================
// Summary Generation Options
// =============================================================================

/**
 * Pre-summary generation options
 */
export interface PreSummaryOptions {
  /** DNA style ID to use */
  dnaStyleId?: string;
  /** Additional options */
  options?: Record<string, unknown>;
}

/**
 * Summary generation options
 */
export interface SummaryOptions {
  /** Custom transcription to use (overrides auto-collected) */
  transcription?: string;
  /** DNA style ID to use */
  dnaStyleId?: string;
  /** Template name/ID to use */
  template?: string;
  /** Include NER entities in summary */
  includeNER?: boolean;
  /** Include shared context from chain */
  includeSharedContext?: boolean;
  /** Additional options */
  options?: Record<string, unknown>;
}

// =============================================================================
// Async Summary Job Types (SUM-01)
// =============================================================================

/**
 * Status of an async summary job.
 */
export type SummaryJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Response from async summary generation endpoints (HTTP 202).
 *
 * Backend returns a job ID that can be polled for status/result.
 */
export interface AsyncJobResponse {
  /** Unique job ID */
  jobId: string;
  /** Current job status */
  status: SummaryJobStatus;
  /** Consultation this job is for */
  consultationId: string;
  /** Creation timestamp */
  createdAt: string;
  /** Progress percentage (0-100), available while processing */
  progress?: number;
  /** Summary result, available when status is 'completed' */
  result?: Partial<SummaryResponse>;
  /** Error message, available when status is 'failed' */
  errorMessage?: string;
}

// =============================================================================
// Comprehensive Summary Types (SUM-02)
// =============================================================================

/**
 * Response from comprehensive (cross-chain) summary generation.
 *
 * Aggregates content across linked consultations in a chain.
 */
export interface ComprehensiveSummaryResponse {
  /** Summary ID */
  id: string;
  /** Summary content */
  content: string;
  /** IDs of consultations included in the comprehensive summary */
  consultationIds: string[];
  /** Creation timestamp */
  createdAt: string;
  /** LLM model used */
  modelName?: string;
  /** Processing time in milliseconds */
  processingTimeMs?: number;
  /** DNA style ID if used */
  dnaStyleId?: string;
}

/**
 * Options for comprehensive summary generation.
 */
export interface ComprehensiveSummaryOptions {
  /** DNA style ID to use */
  dnaStyleId?: string;
  /** Include NER entities in summary */
  includeNER?: boolean;
  /** Additional options */
  options?: Record<string, unknown>;
}

// =============================================================================
// Summary State & Actions
// =============================================================================

/**
 * Summary state exposed by useArca hook
 */
export interface SummaryState {
  /** Latest pre-summary */
  preSummary: SummaryResponse | null;
  /** Latest final summary */
  summary: SummaryResponse | null;
  /** All summaries for current consultation */
  all: SummaryResponse[];
  /** Current DNA writing style */
  dnaStyle: DNAStyle | null;
  /** Whether summary is being generated */
  isGenerating: boolean;
  /** Whether DNA is being analyzed */
  isAnalyzingDNA: boolean;
  /** Error if any */
  error: Error | null;
}

/**
 * Summary actions interface
 */
export interface SummaryActions {
  /** Generate a pre-summary from case notes */
  generatePreSummary: (options?: PreSummaryOptions) => Promise<SummaryResponse>;
  /** Generate a final summary */
  generateSummary: (options?: SummaryOptions) => Promise<SummaryResponse>;
  /** Update an existing summary */
  updateSummary: (id: string, content: string) => Promise<void>;
  /**
   * Analyze texts to create/update DNA style.
   * @deprecated No backend endpoint exists for DNA analysis (SUM-06).
   * This method will throw at runtime. Planned for a future release.
   */
  analyzeDNA: (texts: string[]) => Promise<DNAStyle>;
  /**
   * Load user's DNA style.
   * @deprecated No backend endpoint exists for DNA style loading (HOOK-03).
   * This method will throw at runtime. Planned for a future release.
   */
  loadDNAStyle: (userId?: string) => Promise<DNAStyle | null>;
}

// =============================================================================
// Summary Versioning Types (WS-3)
// =============================================================================

/**
 * Options for updating a summary with change tracking metadata.
 * Passed to SummaryService.updateSummary() to create a version snapshot.
 */
export interface UpdateSummaryOptions {
  changeReason?: string;
  changeSummary?: string;
  changeSource?: 'doctor_edit' | 'ai_regeneration' | 'system';
}

/**
 * A version snapshot of a summary (ContextItemVersion).
 * Created automatically when a summary is updated.
 */
export interface SummaryVersionEntry {
  id: string;
  contextItemId: string;
  versionNumber: number;
  content: string;
  changeReason?: string;
  changeSource?: string;
  changedBy?: string;
  createdAt: string;
}

/**
 * Lightweight summary metadata for listing/display.
 */
export interface SummaryMeta {
  id: string;
  type: string;
  versionNumber: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Extended Summary Generation Options (WS-B)
// =============================================================================

/**
 * Extended options for summary generation via useArca hook.
 * Allows passing transcript text, prompt template, and department directly.
 */
export interface SummaryGenerationOptions {
  dnaStyleId?: string;
  includeNER?: boolean;
  transcript?: string;
  promptTemplateId?: string;
  departmentId?: string;
}

// =============================================================================
// Summary Approval Types (Story 148)
// =============================================================================

/**
 * Approval status for a finalized summary.
 * Approved summaries are locked and cannot be further edited without reopening.
 */
export type SummaryApprovalStatus = 'DRAFT' | 'APPROVED' | 'LOCKED';

/**
 * Response from approving a summary.
 */
export interface SummaryApprovalResponse {
  contextItemId: string;
  approvalStatus: SummaryApprovalStatus;
  approvedBy: string;
  approvedAt: string;
}

// =============================================================================
// Default Values
// =============================================================================

/**
 * Default summary state
 */
export const DEFAULT_SUMMARY_STATE: SummaryState = {
  preSummary: null,
  summary: null,
  all: [],
  dnaStyle: null,
  isGenerating: false,
  isAnalyzingDNA: false,
  error: null,
};
