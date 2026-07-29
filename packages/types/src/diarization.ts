/**
 * Speaker diarization types
 */

/**
 * Diarization options
 */
export interface DiarizationOptions {
  /** Minimum number of speakers (optional) */
  minSpeakers?: number;

  /** Maximum number of speakers (optional) */
  maxSpeakers?: number;

  /** Cosine similarity threshold for clustering (0-1) */
  clusteringThreshold?: number; // default: 0.75

  /** Window size in seconds for embedding extraction */
  windowSize?: number; // default: 3.0

  /** Overlap between windows in seconds */
  windowOverlap?: number; // default: 1.5

  /** Minimum segment duration in seconds */
  minSegmentDuration?: number; // default: 0.5

  /** Model variant to use */
  modelVariant?: 'small' | 'medium' | 'large'; // default: 'small'

  /** Enable progress callbacks */
  reportProgress?: boolean; // default: true
}

/**
 * Speaker segment from diarization
 */
export interface SpeakerSegment {
  /** Unique segment ID */
  id: string;

  /** Start time in seconds */
  startTime: number;

  /** End time in seconds */
  endTime: number;

  /** Duration in seconds */
  duration: number;

  /** Speaker label (e.g., "Speaker_01") */
  speakerLabel: string;

  /** Confidence score (0-1) */
  confidence: number;

  /** Speaker embedding (optional, for future recognition) */
  embedding?: Float32Array;
}

/**
 * Complete diarization result
 */
export interface DiarizationResult {
  /** All speaker segments */
  segments: SpeakerSegment[];

  /** Total number of unique speakers detected */
  numSpeakers: number;

  /** Processing duration in seconds */
  processingTime: number;

  /** Audio duration in seconds */
  audioDuration: number;

  /** Model used for diarization */
  modelUsed: string;

  /** Metadata about the diarization */
  metadata: {
    windowSize: number;
    windowOverlap: number;
    clusteringThreshold: number;
    totalSegments: number;
  };
}

/**
 * Diarization progress event
 */
export interface DiarizationProgress {
  /** Progress percentage (0-100) */
  progress: number;

  /** Current processing stage */
  stage: 'preprocessing' | 'segmentation' | 'embedding' | 'clustering' | 'postprocessing';

  /** Stage-specific message */
  message: string;

  /** Segments processed so far (optional) */
  segmentsProcessed?: number;

  /** Total segments to process (optional) */
  totalSegments?: number;
}

/**
 * Internal audio segment for processing
 */
export interface AudioSegment {
  /** Start time in seconds */
  startTime: number;

  /** End time in seconds */
  endTime: number;

  /** Audio data (mono, 16kHz) */
  audioData: Float32Array;

  /** Speaker embedding (set after extraction) */
  embedding?: Float32Array;

  /** Cluster assignment (set after clustering) */
  cluster?: number;
}

/**
 * Clustering options
 */
export interface ClusteringOptions {
  /** Similarity threshold (0-1) */
  threshold: number;

  /** Minimum number of clusters */
  minClusters?: number;

  /** Maximum number of clusters */
  maxClusters?: number;

  /** Linkage method */
  linkage?: 'single' | 'complete' | 'average'; // default: 'average'
}

/**
 * Model information
 */
export interface DiarizationModelInfo {
  /** Model name/identifier */
  name: string;

  /** Model variant */
  variant: 'small' | 'medium' | 'large';

  /** Model size in bytes */
  size: number;

  /** Model URL for download */
  url: string;

  /** Expected input sample rate */
  sampleRate: number;

  /** Embedding dimension */
  embeddingDim: number;

  /** Is model cached locally */
  isCached: boolean;
}

/**
 * Diarization error codes
 */
export enum DiarizationErrorCode {
  MODEL_NOT_FOUND = 'model_not_found',
  MODEL_LOAD_FAILED = 'model_load_failed',
  INVALID_AUDIO = 'invalid_audio',
  PROCESSING_FAILED = 'processing_failed',
  INSUFFICIENT_MEMORY = 'insufficient_memory',
  CANCELLED = 'cancelled',
  UNSUPPORTED_BROWSER = 'unsupported_browser',
}

/**
 * Diarization error
 */
export interface DiarizationError {
  code: DiarizationErrorCode;
  message: string;
  originalError?: Error;
  details?: Record<string, any>;
}

/**
 * Diarization initialization options
 */
export interface DiarizationInitOptions {
  /** Model ID from registry (preferred) */
  modelId?: string;

  /** Custom model URL (overrides registry, similar to VAD) */
  modelUrl?: string;

  /** @deprecated Use modelId instead. Model variant to load */
  modelVariant?: 'small' | 'medium' | 'large';

  /** Force re-download of model */
  forceDownload?: boolean;

  /** Progress callback for model download */
  onDownloadProgress?: (progress: number) => void;
}
