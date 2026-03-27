/**
 * @arcaai/vad - Type Definitions
 *
 * Core type definitions for the Voice Activity Detection plugin.
 */

// ============================================================================
// Model Types
// ============================================================================

/**
 * Available Silero VAD model versions.
 * - 'v5': Latest Silero VAD v5 with 512-sample frames (recommended)
 * - 'legacy': Legacy model with 1536-sample frames
 */
export type VADModel = 'v5' | 'legacy';

// ============================================================================
// VAD Options
// ============================================================================

/**
 * Configuration options for the VADProcessor.
 */
export interface VADOptions {
  /**
   * Silero VAD model version to use.
   * @default 'v5'
   */
  model?: VADModel;

  /**
   * Probability threshold above which a frame is considered to contain speech.
   * Higher values require more confidence before detecting speech.
   * @default 0.5
   */
  positiveSpeechThreshold?: number;

  /**
   * Probability threshold below which a frame is considered non-speech.
   * Used to determine when speech has ended.
   * @default 0.35
   */
  negativeSpeechThreshold?: number;

  /**
   * Amount of audio (in milliseconds) to include before detected speech start.
   * Helps capture initial low-energy speech sounds.
   * @default 300
   */
  preSpeechPadMs?: number;

  /**
   * Amount of audio (in milliseconds) to include after detected speech end.
   * Helps capture trailing speech sounds.
   * @default 300
   */
  postSpeechPadMs?: number;

  /**
   * Minimum duration (in milliseconds) for a segment to be considered valid speech.
   * Segments shorter than this will trigger onVADMisfire instead of onSpeechEnd.
   * @default 250
   */
  minSpeechMs?: number;

  /**
   * Duration (in milliseconds) of consecutive non-speech frames required
   * to conclude that speech has ended.
   * @default 1400
   */
  redemptionMs?: number;

  /**
   * Base path for VAD assets (worklet, ONNX model).
   * If not provided, uses jsDelivr CDN.
   */
  baseAssetPath?: string;

  /**
   * Base path for ONNX Runtime WASM files.
   * If not provided, uses jsDelivr CDN.
   */
  onnxWASMBasePath?: string;

  /**
   * Sample rate for output audio in speech end events.
   * The VAD model always processes at 16kHz internally.
   * @default 16000
   */
  sampleRate?: number;

  /**
   * Enable debug mode for verbose console logging of configuration.
   * @default false
   */
  debugMode?: boolean;

  /**
   * Enable statistics emission for monitoring.
   * @default false
   */
  enableStats?: boolean;

  /**
   * Interval for stats emission in milliseconds.
   * @default 1000
   */
  statsInterval?: number;

  /**
   * Additional audio constraints to pass to getUserMedia.
   * Note: channelCount, echoCancellation, autoGainControl, and noiseSuppression
   * are managed by default.
   */
  additionalAudioConstraints?: Partial<MediaTrackConstraints>;

  /**
   * Whether to submit the current audio segment when pausing the VAD.
   * @default false
   */
  submitUserSpeechOnPause?: boolean;
}

/**
 * Default options for VADProcessor.
 */
export const DEFAULT_VAD_OPTIONS: Required<Omit<VADOptions, 'baseAssetPath' | 'onnxWASMBasePath' | 'additionalAudioConstraints' | 'debugMode'>> = {
  model: 'v5',
  positiveSpeechThreshold: 0.5,
  negativeSpeechThreshold: 0.35,
  preSpeechPadMs: 300,
  postSpeechPadMs: 300,
  minSpeechMs: 250,
  redemptionMs: 1400,
  sampleRate: 16000,
  enableStats: false,
  statsInterval: 1000,
  submitUserSpeechOnPause: false,
};

// ============================================================================
// VAD Statistics
// ============================================================================

/**
 * Statistics about VAD processing.
 */
export interface VADStats {
  /**
   * Whether the VAD is currently active and processing.
   */
  isActive: boolean;

  /**
   * Whether speech is currently detected.
   */
  isSpeaking: boolean;

  /**
   * Current speech probability (0-1).
   */
  speechProbability: number;

  /**
   * Duration of current speech segment in milliseconds.
   * 0 if not currently speaking.
   */
  currentSpeechDuration: number;

  /**
   * Total number of frames processed.
   */
  framesProcessed: number;

  /**
   * Total number of speech segments detected.
   */
  speechSegmentsDetected: number;

  /**
   * Number of misfires (speech too short).
   */
  misfireCount: number;

  /**
   * Average speech probability over recent frames.
   */
  averageSpeechProbability: number;

  /**
   * Timestamp when stats were collected.
   */
  timestamp: number;
}

// ============================================================================
// VAD Event Payloads
// ============================================================================

/**
 * Payload for VAD frame processing event.
 * Emitted after each audio frame is processed.
 */
export interface VADFramePayload {
  /**
   * Whether speech is detected in this frame.
   */
  isSpeech: boolean;

  /**
   * Speech probability (0-1) for this frame.
   */
  probability: number;

  /**
   * Non-speech probability (0-1) for this frame.
   */
  notSpeechProbability: number;

  /**
   * Timestamp when the frame was processed.
   */
  timestamp: number;
}

/**
 * Payload for speech start event.
 */
export interface VADSpeechStartPayload {
  /**
   * Timestamp when speech started.
   */
  timestamp: number;
}

/**
 * Payload for real speech start event.
 * Triggered when speech exceeds minimum speech frames threshold.
 */
export interface VADSpeechRealStartPayload {
  /**
   * Timestamp when real speech was confirmed.
   */
  timestamp: number;
}

/**
 * Payload for speech end event.
 */
export interface VADSpeechEndPayload {
  /**
   * Audio samples of the speech segment.
   * Float32Array with values between -1 and 1, at 16kHz sample rate.
   */
  audio: Float32Array;

  /**
   * Sequential segment number (1-based), assigned by VAD for each detected speech segment.
   */
  segmentNumber: number;

  /**
   * Timestamp when speech started (wall-clock, Date.now()).
   */
  startTime: number;

  /**
   * Timestamp when speech ended (wall-clock, Date.now()).
   */
  endTime: number;

  /**
   * Start time of the segment in seconds, relative to the audio stream start.
   */
  streamStartSec: number;

  /**
   * End time of the segment in seconds, relative to the audio stream start.
   */
  streamEndSec: number;

  /**
   * Duration of the speech segment in seconds.
   */
  durationSec: number;
}

/**
 * Payload for VAD misfire event.
 * Triggered when speech start is detected but the segment is shorter than minSpeechMs.
 */
export interface VADMisfirePayload {
  /**
   * Duration of the detected segment in milliseconds.
   */
  duration: number;

  /**
   * Timestamp when the misfire occurred.
   */
  timestamp: number;
}

/**
 * Payload for VAD statistics event.
 */
export interface VADStatsPayload {
  type: 'vad-stats';
  data: VADStats;
  timestamp: number;
}

/**
 * All possible VAD data event types.
 */
export type VADDataEventType = 'vad-frame' | 'vad-speech-start' | 'vad-speech-real-start' | 'vad-speech-end' | 'vad-misfire' | 'vad-stats';

// ============================================================================
// Worklet Message Types
// ============================================================================

/**
 * Messages sent to the VAD AudioWorklet.
 */
export type VADWorkletInboundMessage =
  | { type: 'init'; config: VADWorkletConfig }
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'updateThreshold'; positiveSpeechThreshold: number; negativeSpeechThreshold: number }
  | { type: 'getStats' }
  | { type: 'destroy' };

/**
 * Configuration passed to the VAD worklet during initialization.
 */
export interface VADWorkletConfig {
  model: VADModel;
  positiveSpeechThreshold: number;
  negativeSpeechThreshold: number;
  frameSamples: number;
  sampleRate: number;
}

/**
 * Messages sent from the VAD AudioWorklet.
 */
export type VADWorkletOutboundMessage =
  | { type: 'ready' }
  | { type: 'frame'; isSpeech: boolean; probability: number; timestamp: number }
  | { type: 'stats'; stats: VADStats }
  | { type: 'error'; message: string }
  | { type: 'destroyed' };

// ============================================================================
// Browser Support Types
// ============================================================================

/**
 * Browser support information for VAD features.
 */
export interface VADBrowserSupport {
  /**
   * Whether WebAssembly is supported.
   */
  webAssembly: boolean;

  /**
   * Whether AudioWorklet is supported.
   */
  audioWorklet: boolean;

  /**
   * Whether SharedArrayBuffer is supported.
   * Required for multi-threaded ONNX Runtime.
   */
  sharedArrayBuffer: boolean;

  /**
   * Whether ONNX Runtime Web is supported.
   */
  onnxRuntime: boolean;

  /**
   * Whether all required features are supported for Silero VAD.
   */
  vadSupported: boolean;

  /**
   * Reason if not supported.
   */
  unsupportedReason?: string;

  /**
   * Recommended model based on browser capabilities.
   */
  recommendedModel: VADModel;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Error codes specific to the VAD processor.
 */
export enum VADErrorCode {
  /** ONNX model failed to load */
  MODEL_LOAD_FAILED = 'MODEL_LOAD_FAILED',
  /** ONNX Runtime WASM failed to load */
  WASM_LOAD_FAILED = 'WASM_LOAD_FAILED',
  /** AudioWorklet registration failed */
  WORKLET_REGISTRATION_FAILED = 'WORKLET_REGISTRATION_FAILED',
  /** Processing error occurred */
  PROCESSING_ERROR = 'PROCESSING_ERROR',
  /** Browser does not support required features */
  NOT_SUPPORTED = 'NOT_SUPPORTED',
  /** Invalid configuration provided */
  INVALID_CONFIG = 'INVALID_CONFIG',
  /** VAD is already running */
  ALREADY_RUNNING = 'ALREADY_RUNNING',
  /** VAD is not initialized */
  NOT_INITIALIZED = 'NOT_INITIALIZED',
}

/**
 * Custom error class for VAD processor errors.
 */
export class VADError extends Error {
  constructor(
    public readonly code: VADErrorCode,
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'VADError';
  }
}

// ============================================================================
// Callback Types
// ============================================================================

/**
 * Callback function for speech start event.
 */
export type OnSpeechStartCallback = () => void;

/**
 * Callback function for real speech start event.
 */
export type OnSpeechRealStartCallback = () => void;

/**
 * Callback function for speech end event.
 * @param audio - Float32Array of audio samples at 16kHz
 */
export type OnSpeechEndCallback = (audio: Float32Array) => void;

/**
 * Callback function for VAD misfire event.
 */
export type OnVADMisfireCallback = () => void;

/**
 * Callback function for frame processed event.
 * @param probabilities - Speech and non-speech probabilities
 * @param frame - Raw audio frame data
 */
export type OnFrameProcessedCallback = (probabilities: { isSpeech: number; notSpeech: number }, frame: Float32Array) => void;

/**
 * Extended VAD options with callback functions.
 */
export interface VADOptionsWithCallbacks extends VADOptions {
  /**
   * Callback when speech starts.
   */
  onSpeechStart?: OnSpeechStartCallback;

  /**
   * Callback when real speech is confirmed (exceeds min speech frames).
   */
  onSpeechRealStart?: OnSpeechRealStartCallback;

  /**
   * Callback when speech ends with the audio segment.
   */
  onSpeechEnd?: OnSpeechEndCallback;

  /**
   * Callback when speech is too short (misfire).
   */
  onVADMisfire?: OnVADMisfireCallback;

  /**
   * Callback after each frame is processed.
   */
  onFrameProcessed?: OnFrameProcessedCallback;
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { AudioProcessorOptions, ProcessorOptions, TrackProcessor, EventEmittingProcessor } from '@arcaai/room';
