/**
 * Voice Recognition Types
 * Types for voice enrollment, embeddings, and speaker recognition
 */

// Browser API types (available in browser environment)


/**
 * Voice profile stored in database
 */
export interface VoiceProfile {
  id: string;
  personName: string;
  embeddings: VoiceEmbedding[];
  metadata: VoiceProfileMetadata;
  encryption: EncryptionMetadata;
}

/**
 * Individual voice embedding from a sample
 */
export interface VoiceEmbedding {
  /** 192-dimensional embedding vector (ECAPA-TDNN standard) */
  embedding: Float32Array;
  /** Timestamp when embedding was created */
  timestamp: number;
  /** Quality score (0-1) */
  quality: number;
  /** Duration of audio sample in seconds */
  sampleDuration: number;
  /** Sample rate in Hz */
  sampleRate: number;
}

/**
 * Voice profile metadata
 */
export interface VoiceProfileMetadata {
  /** When profile was created */
  createdAt: number;
  /** Last time profile was updated */
  updatedAt: number;
  /** Number of voice samples */
  numberOfSamples: number;
  /** Average quality of all samples (0-1) */
  averageQuality: number;
  /** Last time profile was used for recognition */
  lastUsed?: number;
  /** Number of times profile was used */
  usageCount: number;
  /** Optional tags for organization */
  tags?: string[];
}

/**
 * Encryption metadata for voice profile
 */
export interface EncryptionMetadata {
  /** Encryption algorithm used */
  algorithm: 'AES-GCM';
  /** Key identifier */
  keyId: string;
  /** Initialization vector */
  iv: Uint8Array;
  /** Salt for key derivation */
  salt: Uint8Array;
}

/**
 * Voice profile metadata without embeddings (for list views)
 */
export interface VoiceProfileMetadataOnly {
  id: string;
  personName: string;
  metadata: VoiceProfileMetadata;
}

/**
 * Enrollment session (temporary, in-memory)
 */
export interface EnrollmentSession {
  /** Unique session identifier */
  sessionId: string;
  /** Person's name */
  personName: string;
  /** Collected samples */
  samples: EnrollmentSample[];
  /** Session status */
  status: EnrollmentSessionStatus;
  /** When session was created */
  createdAt: number;
  /** When session expires */
  expiresAt: number;
}

/**
 * Enrollment session status
 */
export type EnrollmentSessionStatus = 'active' | 'completed' | 'cancelled' | 'expired';

/**
 * Enrollment sample (temporary, in-memory)
 */
export interface EnrollmentSample {
  /** Unique sample identifier */
  sampleId: string;
  /** Audio blob */
  audioBlob: Blob;
  /** Generated embedding */
  embedding: Float32Array;
  /** Quality score (0-1) */
  quality: number;
  /** When sample was recorded */
  timestamp: number;
  /** Duration in seconds */
  duration: number;
}

/**
 * Result of adding a sample to enrollment
 */
export interface EnrollmentSampleResult {
  /** Sample identifier */
  sampleId: string;
  /** Quality score (0-1) */
  quality: number;
  /** Generated embedding */
  embedding: Float32Array;
  /** Whether sample is valid */
  isValid: boolean;
  /** Feedback message if not valid */
  feedback?: string;
}

/**
 * Enrollment session status information
 */
export interface EnrollmentSessionStatusInfo {
  /** Session identifier */
  sessionId: string;
  /** Person's name */
  personName: string;
  /** Number of samples collected */
  samplesCollected: number;
  /** Number of samples required */
  samplesRequired: number;
  /** Average quality of collected samples */
  averageQuality: number;
  /** Whether enrollment can be completed */
  canComplete: boolean;
}

/**
 * Audio quality validation result
 */
export interface AudioQualityResult {
  /** Whether audio is valid */
  isValid: boolean;
  /** Overall quality score (0-1) */
  quality: number;
  /** List of quality issues */
  issues: AudioQualityIssue[];
  /** Detailed metrics */
  metrics: AudioQualityMetrics;
}

/**
 * Audio quality metrics
 */
export interface AudioQualityMetrics {
  /** Signal-to-noise ratio in dB */
  snr: number;
  /** Duration in seconds */
  duration: number;
  /** RMS (root mean square) amplitude */
  rms: number;
  /** Peak amplitude */
  peak: number;
  /** Percentage of clipped samples */
  clippingPercent: number;
}

/**
 * Audio quality issue
 */
export interface AudioQualityIssue {
  /** Issue type */
  type: AudioQualityIssueType;
  /** Issue severity */
  severity: 'error' | 'warning';
  /** Human-readable message */
  message: string;
  /** Suggestion for improvement */
  suggestion: string;
}

/**
 * Types of audio quality issues
 */
export type AudioQualityIssueType =
  | 'snr' // Signal-to-noise ratio too low
  | 'duration' // Duration too short or too long
  | 'volume' // Volume too quiet or too loud
  | 'clipping'; // Audio clipping detected

/**
 * Voice embedding generation result
 */
export interface VoiceEmbeddingResult {
  /** Generated embedding vector */
  embedding: Float32Array;
  /** Quality score (0-1) */
  quality: number;
}

/**
 * Embedding validation result
 */
export interface EmbeddingValidationResult {
  /** Whether embedding is valid */
  isValid: boolean;
  /** Quality score (0-1) */
  quality: number;
  /** Feedback message if not valid */
  feedback?: string;
}

/**
 * Voice profile statistics
 */
export interface VoiceProfileStats {
  /** Profile identifier */
  profileId: string;
  /** Total number of times used */
  totalUsages: number;
  /** Last time used */
  lastUsed?: number;
  /** Average recognition confidence */
  averageConfidence: number;
  /** Number of meetings where profile was used */
  meetingsCount: number;
}

/**
 * Suggested phrases for voice enrollment
 * These 3 sentences provide good phonetic coverage for voice profiling
 * Longer phrases help capture more voice characteristics and improve profile quality
 */
export const ENROLLMENT_PHRASES = [
  'My voice is my password, and I use it to authenticate my identity securely',
  'Your name is unknown to me, but I would like to learn more about who you are',
  'Five, nine, three, eight, two, seven, one, four, six, zero are the numbers I need to remember',
] as const;

/**
 * Audio quality thresholds
 */
export const AUDIO_QUALITY_THRESHOLDS = {
  /** Minimum duration in seconds - short for easy enrollment */
  MIN_DURATION: 3, // Lowered from 5 for easier enrollment
  /** Maximum duration in seconds */
  MAX_DURATION: 30,
  /** Minimum signal-to-noise ratio in dB */
  MIN_SNR: 10, // Lowered from 12 for easier enrollment
  /** Minimum RMS amplitude - very lenient for Bluetooth/AirPods */
  MIN_RMS: 0.001, // Very low to support all devices
  /** Maximum RMS amplitude */
  MAX_RMS: 0.8,
  /** Maximum clipping percentage */
  MAX_CLIPPING_PERCENT: 1,
} as const;

/**
 * Embedding configuration
 */
export const EMBEDDING_CONFIG = {
  /** Expected embedding dimension */
  DIMENSION: 256,
  /** Minimum quality score to accept embedding - lowered for easier enrollment */
  MIN_QUALITY: 0.5, // Lowered from 0.6 for easier enrollment
  /** Required number of samples for enrollment */
  MIN_SAMPLES: 3,
  /** Maximum number of samples for enrollment */
  MAX_SAMPLES: 5,
  /** Cosine similarity threshold for same speaker */
  SIMILARITY_THRESHOLD: 0.65, // Lowered slightly from 0.7
} as const;

/**
 * Error codes for voice recognition operations
 */
export enum VoiceRecognitionErrorCode {
  // Enrollment errors
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_ALREADY_COMPLETED = 'SESSION_ALREADY_COMPLETED',
  INVALID_PERSON_NAME = 'INVALID_PERSON_NAME',
  INSUFFICIENT_SAMPLES = 'INSUFFICIENT_SAMPLES',

  // Audio quality errors
  AUDIO_TOO_SHORT = 'AUDIO_TOO_SHORT',
  AUDIO_TOO_LONG = 'AUDIO_TOO_LONG',
  AUDIO_TOO_QUIET = 'AUDIO_TOO_QUIET',
  AUDIO_TOO_LOUD = 'AUDIO_TOO_LOUD',
  AUDIO_LOW_SNR = 'AUDIO_LOW_SNR',
  AUDIO_CLIPPING = 'AUDIO_CLIPPING',

  // Model errors
  MODEL_NOT_LOADED = 'MODEL_NOT_LOADED',
  MODEL_LOAD_FAILED = 'MODEL_LOAD_FAILED',
  INFERENCE_FAILED = 'INFERENCE_FAILED',
  INVALID_MODEL_OUTPUT = 'INVALID_MODEL_OUTPUT',

  // Embedding errors
  EMBEDDING_GENERATION_FAILED = 'EMBEDDING_GENERATION_FAILED',
  EMBEDDING_LOW_QUALITY = 'EMBEDDING_LOW_QUALITY',
  INVALID_EMBEDDING_DIMENSION = 'INVALID_EMBEDDING_DIMENSION',

  // Storage errors
  PROFILE_NOT_FOUND = 'PROFILE_NOT_FOUND',
  PROFILE_SAVE_FAILED = 'PROFILE_SAVE_FAILED',
  PROFILE_DELETE_FAILED = 'PROFILE_DELETE_FAILED',
  ENCRYPTION_FAILED = 'ENCRYPTION_FAILED',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
  STORAGE_QUOTA_EXCEEDED = 'STORAGE_QUOTA_EXCEEDED',
}

/**
 * Voice recognition error
 */
export class VoiceRecognitionError extends Error {
  constructor(
    public code: VoiceRecognitionErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'VoiceRecognitionError';
  }
}

