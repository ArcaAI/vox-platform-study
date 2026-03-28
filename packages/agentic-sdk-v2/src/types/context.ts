/**
 * @arcaai/vox - Context Types
 *
 * Types for context items (case notes, transcriptions, summaries, etc.)
 * and medical entity extraction.
 */

// =============================================================================
// Context Item Entity
// =============================================================================

/**
 * Context item from backend
 * Represents any piece of context in a consultation
 */
export interface ContextItem {
  /** Unique item ID */
  id: string;
  /** Consultation this item belongs to */
  consultationId: string;
  /** Item type (CASE_NOTE, TRANSCRIPT, RAW_SUMMARY, PRE_SUMMARY, etc.) */
  type: ContextItemType | string;
  /** Text content */
  content: string;
  /** Structured data (e.g., transcription segments, entities) */
  structuredData?: Record<string, unknown>;
  /** Source of the item */
  source: ContextSource;
  /** Derived: true if type is summary or pre_summary */
  isSummary: boolean;
  /** Derived: true if type is transcription */
  isTranscription: boolean;
  /** Derived: true if source is AI */
  isAiGenerated: boolean;
  /** Creation timestamp */
  createdAt: string;
  /** Last update timestamp */
  updatedAt: string;
}

/**
 * Standard context item types.
 * Values MUST match the API's ContextItemType enum (uppercase, underscore-separated).
 */
export type ContextItemType =
  | 'CASE_NOTE'
  | 'TRANSCRIPT'
  | 'RAW_SUMMARY'
  | 'MODIFIED_SUMMARY'
  | 'PRE_SUMMARY'
  | 'AUDIO_RECORDING'
  | 'WORKNOTE'
  | 'NAMED_ENTITY'
  | 'ATTACHMENT';

/**
 * Context item source.
 * Values MUST match the API's ContextItemSource enum (uppercase).
 */
export type ContextSource = 'USER' | 'SYSTEM' | 'TRANSCRIPTION' | 'AI';

// =============================================================================
// Medical Entity (NER)
// =============================================================================

/**
 * Medical entity extracted via NER
 */
export interface MedicalEntity {
  /** Unique entity ID */
  id: string;
  /** Entity type (DISEASE, SYMPTOM, MEDICATION, etc.) */
  entityType: MedicalEntityType | string;
  /** Original text in content */
  text: string;
  /** Normalized text (standardized form) */
  normalizedText?: string;
  /** Medical codes */
  codes?: MedicalCodes;
  /** Confidence score (0-1) */
  confidence: number;
  /** Start offset in source content */
  startOffset: number;
  /** End offset in source content */
  endOffset: number;
}

/**
 * Standard medical entity types
 */
export type MedicalEntityType = 'DISEASE' | 'SYMPTOM' | 'MEDICATION' | 'PROCEDURE' | 'ANATOMY' | 'TEST' | 'DOSAGE' | 'DURATION' | 'FREQUENCY';

/**
 * Medical codes for entities
 */
export interface MedicalCodes {
  /** ICD-10 codes */
  icd10?: string[];
  /** SNOMED CT codes */
  snomed?: string[];
  /** RxNorm codes (for medications) */
  rxnorm?: string[];
}

// =============================================================================
// NER Data Response
// =============================================================================

/**
 * NER data response from backend
 */
export interface NERData {
  /** Extracted entities */
  entities: MedicalEntity[];
  /** Context item ID if extracted from specific item */
  contextItemId?: string;
  /** Processing timestamp */
  processedAt?: string;
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Input for adding a context item
 */
export interface AddContextInput {
  /** Item type */
  type: ContextItemType | string;
  /** Text content */
  content: string;
  /** Structured data */
  structuredData?: Record<string, unknown>;
  /** Source (defaults to 'USER') */
  source?: ContextSource;
}

/**
 * Case note input (convenience type)
 */
export interface CaseNoteInput {
  /** Note content */
  content: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Context filters for querying (SES-06: pagination support added)
 */
export interface ContextFilters {
  /** Filter by type */
  type?: ContextItemType | string;
  /** Filter by source */
  source?: ContextSource;
  /** Limit results */
  limit?: number;
  /** Page number (1-based) for pagination (SES-06) */
  page?: number;
}

// =============================================================================
// Context Version History (SES-05)
// =============================================================================

/**
 * A single version entry from context item version history.
 *
 * Backend tracks each edit to a context item as a separate version.
 */
export interface ContextVersionEntry {
  /** Version number (1-based, incrementing) */
  versionNumber: number;
  /** Content at this version */
  content: string;
  /** When this version was created */
  updatedAt: string;
  /** Who made the change (user ID or system) */
  updatedBy?: string;
  /** Optional description of what changed */
  changeDescription?: string;
}

// =============================================================================
// Context State & Actions
// =============================================================================

/**
 * Context state exposed by useArca hook
 */
export interface ContextState {
  /** All context items for current consultation */
  items: ContextItem[];
  /** Transcription items only */
  transcriptions: ContextItem[];
  /** Case note items only */
  caseNotes: ContextItem[];
  /** Summary items only (summaries and pre-summaries) */
  summaries: ContextItem[];
  /** Extracted medical entities */
  entities: MedicalEntity[];
  /** Shared context from consultation chain */
  sharedContext: ContextItem[];
  /** Loading state */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
}

/**
 * Context actions interface
 */
export interface ContextActions {
  /** Add a case note */
  addCaseNote: (content: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  /** Add a transcription */
  addTranscription: (text: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  /** Add a generic context item */
  addContext: (input: AddContextInput) => Promise<ContextItem>;
  /** Update an existing context item */
  updateItem: (id: string, content: string) => Promise<void>;
  /** Get context items with optional filters */
  getItems: (filters?: ContextFilters) => Promise<ContextItem[]>;
  /** Load shared context from consultation chain */
  loadSharedContext: () => Promise<ContextItem[]>;
  /** Extract medical entities (NER) */
  extractEntities: (contextItemId?: string) => Promise<MedicalEntity[]>;
  /** Clear local context state */
  clear: () => void;
}
