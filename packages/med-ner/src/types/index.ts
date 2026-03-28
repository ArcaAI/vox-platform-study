/**
 * @arcaai/med-ner - Type Definitions
 *
 * Core type definitions for the Medical Named Entity Recognition plugin.
 */

// ============================================================================
// Medical Entity Types
// ============================================================================

/**
 * Medical entity categories for NER extraction.
 */
export enum MedicalEntityType {
  /** Disease or medical condition (e.g., diabetes, hypertension) */
  DISEASE = 'DISEASE',
  /** Medication or drug name (e.g., aspirin, metformin) */
  MEDICATION = 'MEDICATION',
  /** Medical procedure (e.g., MRI, colonoscopy) */
  PROCEDURE = 'PROCEDURE',
  /** Anatomical location (e.g., liver, left arm) */
  ANATOMY = 'ANATOMY',
  /** Laboratory test or value (e.g., glucose level, WBC count) */
  LAB_VALUE = 'LAB_VALUE',
  /** Symptom or sign (e.g., chest pain, fever) */
  SYMPTOM = 'SYMPTOM',
  /** Dosage information (e.g., 500mg, 2 tablets) */
  DOSAGE = 'DOSAGE',
  /** Frequency information (e.g., twice daily, every 8 hours) */
  FREQUENCY = 'FREQUENCY',
  /** Duration information (e.g., for 7 days, 2 weeks) */
  DURATION = 'DURATION',
  /** Gene or protein name */
  GENE = 'GENE',
  /** Chemical compound */
  CHEMICAL = 'CHEMICAL',
  /** Other medical entity */
  OTHER = 'OTHER',
}

/**
 * Mapping from raw model labels to MedicalEntityType.
 * This handles different labeling schemes from various NER models.
 */
export const LABEL_TO_ENTITY_TYPE: Record<string, MedicalEntityType> = {
  // Common biomedical NER labels
  DISEASE: MedicalEntityType.DISEASE,
  Disease: MedicalEntityType.DISEASE,
  'B-Disease': MedicalEntityType.DISEASE,
  'I-Disease': MedicalEntityType.DISEASE,
  'B-DISEASE': MedicalEntityType.DISEASE,
  'I-DISEASE': MedicalEntityType.DISEASE,

  // Medication/Drug labels
  MEDICATION: MedicalEntityType.MEDICATION,
  DRUG: MedicalEntityType.MEDICATION,
  Drug: MedicalEntityType.MEDICATION,
  'B-Drug': MedicalEntityType.MEDICATION,
  'I-Drug': MedicalEntityType.MEDICATION,
  'B-DRUG': MedicalEntityType.MEDICATION,
  'I-DRUG': MedicalEntityType.MEDICATION,
  'B-MEDICATION': MedicalEntityType.MEDICATION,
  'I-MEDICATION': MedicalEntityType.MEDICATION,

  // Procedure labels
  PROCEDURE: MedicalEntityType.PROCEDURE,
  'B-PROCEDURE': MedicalEntityType.PROCEDURE,
  'I-PROCEDURE': MedicalEntityType.PROCEDURE,

  // Anatomy labels
  ANATOMY: MedicalEntityType.ANATOMY,
  'B-ANATOMY': MedicalEntityType.ANATOMY,
  'I-ANATOMY': MedicalEntityType.ANATOMY,
  'B-Body_Part': MedicalEntityType.ANATOMY,
  'I-Body_Part': MedicalEntityType.ANATOMY,

  // Lab/Test labels
  LAB_VALUE: MedicalEntityType.LAB_VALUE,
  'B-LAB': MedicalEntityType.LAB_VALUE,
  'I-LAB': MedicalEntityType.LAB_VALUE,
  'B-TEST': MedicalEntityType.LAB_VALUE,
  'I-TEST': MedicalEntityType.LAB_VALUE,

  // Symptom labels
  SYMPTOM: MedicalEntityType.SYMPTOM,
  'B-SYMPTOM': MedicalEntityType.SYMPTOM,
  'I-SYMPTOM': MedicalEntityType.SYMPTOM,
  'B-Sign_symptom': MedicalEntityType.SYMPTOM,
  'I-Sign_symptom': MedicalEntityType.SYMPTOM,

  // Dosage labels
  DOSAGE: MedicalEntityType.DOSAGE,
  'B-DOSAGE': MedicalEntityType.DOSAGE,
  'I-DOSAGE': MedicalEntityType.DOSAGE,
  'B-Dosage': MedicalEntityType.DOSAGE,
  'I-Dosage': MedicalEntityType.DOSAGE,

  // Frequency labels
  FREQUENCY: MedicalEntityType.FREQUENCY,
  'B-FREQUENCY': MedicalEntityType.FREQUENCY,
  'I-FREQUENCY': MedicalEntityType.FREQUENCY,

  // Duration labels
  DURATION: MedicalEntityType.DURATION,
  'B-DURATION': MedicalEntityType.DURATION,
  'I-DURATION': MedicalEntityType.DURATION,

  // Gene/Protein labels
  GENE: MedicalEntityType.GENE,
  'B-GENE': MedicalEntityType.GENE,
  'I-GENE': MedicalEntityType.GENE,
  'B-Gene': MedicalEntityType.GENE,
  'I-Gene': MedicalEntityType.GENE,
  PROTEIN: MedicalEntityType.GENE,
  'B-PROTEIN': MedicalEntityType.GENE,
  'I-PROTEIN': MedicalEntityType.GENE,

  // Chemical labels
  CHEMICAL: MedicalEntityType.CHEMICAL,
  'B-CHEMICAL': MedicalEntityType.CHEMICAL,
  'I-CHEMICAL': MedicalEntityType.CHEMICAL,

  // Generic/fallback labels
  MISC: MedicalEntityType.OTHER,
  'B-MISC': MedicalEntityType.OTHER,
  'I-MISC': MedicalEntityType.OTHER,
  O: MedicalEntityType.OTHER,
};

// ============================================================================
// Entity Span Types
// ============================================================================

/**
 * Represents a single extracted medical entity with position information.
 */
export interface EntitySpan {
  /** The extracted text */
  text: string;
  /** Normalized medical entity type */
  type: MedicalEntityType;
  /** Character start index in the original text */
  start: number;
  /** Character end index in the original text */
  end: number;
  /** Confidence score (0-1) */
  score: number;
  /** Original label from the model */
  rawLabel: string;
  /** Token index (if available) */
  tokenIndex?: number;
}

/**
 * Raw token classification result from Transformers.js pipeline.
 */
export interface RawTokenResult {
  word: string;
  entity: string;
  score: number;
  index: number;
  start: number;
  end: number;
}

// ============================================================================
// NER Options
// ============================================================================

/**
 * Available pre-configured medical NER models.
 */
export type MedNERModel = 'default' | 'biomedical' | 'clinical' | string; // Custom model ID from HuggingFace

/**
 * Default model mappings to HuggingFace model IDs.
 */
export const MODEL_MAP: Record<string, string> = {
  default: 'Xenova/bert-base-NER',
  biomedical: 'Kushtrim/bert-base-cased-biomedical-ner',
  clinical: 'samrawal/bert-base-uncased_clinical-ner',
};

/**
 * Configuration options for the MedNERProcessor.
 */
export interface MedNEROptions {
  /**
   * Model to use for NER.
   * Can be a preset name ('default', 'biomedical', 'clinical') or a HuggingFace model ID.
   * @default 'default'
   */
  model?: MedNERModel;

  /**
   * Confidence threshold for entity extraction (0-1).
   * Entities below this threshold will be filtered out.
   * @default 0.5
   */
  threshold?: number;

  /**
   * Filter to specific entity types.
   * If not provided, all entity types are extracted.
   */
  entityTypes?: MedicalEntityType[];

  /**
   * Whether to merge adjacent entities of the same type.
   * @default true
   */
  mergeAdjacent?: boolean;

  /**
   * Whether to merge overlapping entities (keep highest score).
   * @default true
   */
  mergeOverlapping?: boolean;

  /**
   * Maximum text length to process at once.
   * Longer texts will be chunked.
   * @default 512
   */
  maxLength?: number;

  /**
   * Chunk overlap when processing long texts (in characters).
   * @default 50
   */
  chunkOverlap?: number;

  /**
   * Enable statistics emission.
   * @default false
   */
  enableStats?: boolean;

  /**
   * Interval for stats emission in milliseconds.
   * @default 1000
   */
  statsInterval?: number;

  /**
   * Custom progress callback for model loading.
   */
  onProgress?: (progress: ModelLoadProgress) => void;

  /**
   * Quantization type for model loading.
   * @default 'q8' for browser, 'fp32' for Node.js
   */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
}

/**
 * Default options for MedNERProcessor.
 */
export const DEFAULT_MED_NER_OPTIONS: Required<Omit<MedNEROptions, 'entityTypes' | 'onProgress' | 'dtype'>> = {
  model: 'default',
  threshold: 0.5,
  mergeAdjacent: true,
  mergeOverlapping: true,
  maxLength: 512,
  chunkOverlap: 50,
  enableStats: false,
  statsInterval: 1000,
};

// ============================================================================
// NER Results
// ============================================================================

/**
 * Result of NER extraction on a piece of text.
 */
export interface MedNERResult {
  /** Original input text */
  text: string;
  /** Extracted entities */
  entities: EntitySpan[];
  /** Processing time in milliseconds */
  processingTime: number;
  /** Model used for extraction */
  model: string;
  /** Timestamp of extraction */
  timestamp: number;
}

/**
 * Model loading progress information.
 */
export interface ModelLoadProgress {
  /** Current status */
  status: 'downloading' | 'loading' | 'ready' | 'error';
  /** File being downloaded (if applicable) */
  file?: string;
  /** Progress percentage (0-100) */
  progress?: number;
  /** Total size in bytes (if known) */
  total?: number;
  /** Downloaded size in bytes */
  loaded?: number;
}

// ============================================================================
// Statistics Types
// ============================================================================

/**
 * Processing statistics for monitoring.
 */
export interface MedNERStats {
  /** Whether the processor is ready */
  isReady: boolean;
  /** Whether currently processing */
  isProcessing: boolean;
  /** Total texts processed */
  textsProcessed: number;
  /** Total entities extracted */
  entitiesExtracted: number;
  /** Entity counts by type */
  entityCounts: Record<MedicalEntityType, number>;
  /** Average processing time in ms */
  averageProcessingTime: number;
  /** Average confidence score */
  averageConfidence: number;
  /** Model ID in use */
  modelId: string;
  /** Timestamp of stats collection */
  timestamp: number;
}

// ============================================================================
// Event Payload Types
// ============================================================================

/**
 * Payload for NER extraction completion event.
 */
export interface NERExtractionPayload {
  /** Extraction result */
  result: MedNERResult;
}

/**
 * Payload for NER statistics event.
 */
export interface NERStatsPayload {
  /** Current statistics */
  stats: MedNERStats;
}

/**
 * Payload for model load progress event.
 */
export interface NERProgressPayload {
  /** Progress information */
  progress: ModelLoadProgress;
}

/**
 * All possible NER data event types.
 */
export type NERDataEventType = 'ner-extraction' | 'ner-stats' | 'ner-progress';

// ============================================================================
// Browser Support Types
// ============================================================================

/**
 * Browser support information for NER features.
 */
export interface MedNERBrowserSupport {
  /** Whether WebAssembly is supported */
  webAssembly: boolean;
  /** Whether IndexedDB is supported (for model caching) */
  indexedDB: boolean;
  /** Whether fetch API is supported */
  fetch: boolean;
  /** Whether all required features are supported */
  nerSupported: boolean;
  /** Reason if not supported */
  unsupportedReason?: string;
  /** Recommended quantization type based on device */
  recommendedDtype: 'fp32' | 'fp16' | 'q8' | 'q4';
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes specific to the MedNER processor.
 */
export enum MedNERErrorCode {
  /** Model failed to load */
  MODEL_LOAD_FAILED = 'MODEL_LOAD_FAILED',
  /** Model not found on HuggingFace Hub */
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  /** Processing error occurred */
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  /** Browser does not support required features */
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  /** Invalid configuration provided */
  INVALID_CONFIG = 'INVALID_CONFIG',
  /** Processor not initialized */
  NOT_INITIALIZED = 'NOT_INITIALIZED',
  /** Text is empty or invalid */
  INVALID_INPUT = 'INVALID_INPUT',
  /** Network error during model download */
  NETWORK_ERROR = 'NETWORK_ERROR',
}

/**
 * Custom error class for MedNER processor errors.
 */
export class MedNERError extends Error {
  constructor(
    public readonly code: MedNERErrorCode,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'MedNERError';
  }
}

// ============================================================================
// Callback Types
// ============================================================================

/**
 * Callback for entity extraction completion.
 */
export type OnEntitiesExtractedCallback = (result: MedNERResult) => void;

/**
 * Callback for processing errors.
 */
export type OnNERErrorCallback = (error: MedNERError) => void;

/**
 * Callback for model loading progress.
 */
export type OnProgressCallback = (progress: ModelLoadProgress) => void;

/**
 * Extended NER options with callback functions.
 */
export interface MedNEROptionsWithCallbacks extends MedNEROptions {
  /** Callback when entities are extracted */
  onEntitiesExtracted?: OnEntitiesExtractedCallback;
  /** Callback when an error occurs */
  onError?: OnNERErrorCallback;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { ProcessorOptions, TrackProcessor, EventEmittingProcessor } from '@arcaai/room';
