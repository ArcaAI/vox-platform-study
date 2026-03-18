/**
 * Voice Activity Detection (VAD) types
 */

/**
 * VAD Configuration
 */
export interface VADConfig {
  /** Speech probability threshold (0-1). Default: 0.5 */
  threshold: number;

  /** Minimum speech duration in milliseconds. Default: 250 */
  minSpeechDuration: number;

  /** Minimum silence duration in milliseconds. Default: 500 */
  minSilenceDuration: number;

  /** Window size in samples (512, 1024, or 1536). Default: 1024 */
  windowSize: 512 | 1024 | 1536;

  /** Padding before speech in milliseconds. Default: 100 */
  preSpeechPad: number;

  /** Padding after speech in milliseconds. Default: 100 */
  postSpeechPad: number;

  /** Target sample rate in Hz. Must be 16000 for Silero VAD. */
  sampleRate: number;
}

/**
 * VAD Preset types
 */
export type VADPreset = 'aggressive' | 'balanced' | 'permissive';

/**
 * Speech Segment
 * Represents a detected speech segment with timestamps
 */
export interface SpeechSegment {
  /** Unique identifier for the segment */
  id: string;

  /** Start time in seconds from recording start */
  startTime: number;

  /** End time in seconds from recording start */
  endTime: number;

  /** Average confidence score (0-1) */
  confidence: number;

  /** Sample range [startSample, endSample] */
  samples: [number, number];
}

/**
 * VAD Frame Result
 * Result for a single audio frame
 */
export interface VADFrameResult {
  /** Timestamp in seconds from recording start */
  timestamp: number;

  /** Speech probability (0-1) */
  probability: number;

  /** Whether this frame is classified as speech */
  isSpeech: boolean;
}

/**
 * VAD Processing Result
 * Complete result from VAD processing
 */
export interface VADResult {
  /** Detected speech segments */
  segments: SpeechSegment[];

  /** Total duration of audio in seconds */
  totalDuration: number;

  /** Total speech duration in seconds */
  speechDuration: number;

  /** Total silence duration in seconds */
  silenceDuration: number;

  /** Frame-level results (optional, for debugging) */
  frameResults?: VADFrameResult[];
}

/**
 * VAD Callbacks
 * Callbacks for VAD events
 */
export interface VADCallbacks {
  /** Called when speech starts */
  onSpeechStart?: (timestamp: number) => void;

  /** Called when speech ends */
  onSpeechEnd?: (timestamp: number, segment: SpeechSegment) => void;

  /** Called with VAD probability for each frame */
  onVADProbability?: (probability: number, timestamp: number) => void;

  /** Called when a complete segment is detected */
  onSegmentDetected?: (segment: SpeechSegment) => void;

  /** Called on error */
  onError?: (error: VADError) => void;

  /** Called with progress updates (0-1) for batch processing */
  onProgress?: (progress: number) => void;
}

/**
 * VAD Error Codes
 */
export enum VADErrorCode {
  /** Model failed to load */
  MODEL_LOAD_FAILED = 'model_load_failed',

  /** Model initialization failed */
  MODEL_INIT_FAILED = 'model_init_failed',

  /** Processing failed */
  PROCESSING_FAILED = 'processing_failed',

  /** Invalid audio input */
  INVALID_AUDIO = 'invalid_audio',

  /** Web Worker failed */
  WORKER_FAILED = 'worker_failed',

  /** Not supported */
  NOT_SUPPORTED = 'not_supported',
}

/**
 * VAD Error
 */
export interface VADError {
  /** Error code */
  code: VADErrorCode;

  /** Error message */
  message: string;

  /** Original error if available */
  originalError?: Error;
}

/**
 * VAD State
 */
export enum VADState {
  /** Idle, not initialized */
  IDLE = 'idle',

  /** Loading model */
  LOADING = 'loading',

  /** Ready to process */
  READY = 'ready',

  /** Currently processing */
  PROCESSING = 'processing',

  /** Paused */
  PAUSED = 'paused',

  /** Error state */
  ERROR = 'error',
}

/**
 * VAD Model State
 * Internal state for stateful VAD models (like Silero VAD)
 */
export interface VADModelState {
  /** Hidden state (LSTM) */
  h: Float32Array | null;

  /** Cell state (LSTM) */
  c: Float32Array | null;

  /** Whether state has been initialized */
  initialized: boolean;
}

/**
 * VAD Processing Options
 * Options for processing audio
 */
export interface VADProcessingOptions {
  /** Start time in seconds (for partial processing) */
  startTime?: number;

  /** End time in seconds (for partial processing) */
  endTime?: number;

  /** Whether to reset VAD state before processing */
  resetState?: boolean;

  /** Whether to return frame-level results */
  includeFrameResults?: boolean;
}

