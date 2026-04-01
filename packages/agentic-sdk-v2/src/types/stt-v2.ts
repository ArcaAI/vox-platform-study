/**
 * @arcaai/vox - STT-V2 Types
 *
 * Type definitions for the stt-v2 backend integration:
 * - Streaming session management (REST + WebSocket)
 * - Transcription job lifecycle
 * - ASR pipeline configuration
 * - AI model catalog
 *
 * These types align with backend DTOs from:
 * - apps/api/src/modules/stt-v2/dto/
 * - packages/applications/src/services/stt/
 * - packages/domains/src/enums/generated/
 *
 * @see SDK-206 Gap Analysis — Layer 0 Foundation
 */

// =============================================================================
// Enums (mirroring packages/domains/src/enums/generated/)
// =============================================================================

/**
 * Transcription job type
 * @see packages/domains/src/enums/generated/TranscriptionJobType.ts
 */
export enum TranscriptionJobType {
  BATCH = 'BATCH',
  STREAMING = 'STREAMING',
}

/**
 * Transcription job status
 * @see packages/domains/src/enums/generated/TranscriptionJobStatus.ts
 */
export enum TranscriptionJobStatus {
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  DEAD = 'DEAD',
}

/**
 * AI model download status
 * @see packages/domains/src/enums/generated/AiModelDownloadStatus.ts
 */
export enum AiModelDownloadStatus {
  NOT_DOWNLOADED = 'NOT_DOWNLOADED',
  DOWNLOADING = 'DOWNLOADING',
  DOWNLOADED = 'DOWNLOADED',
  DOWNLOAD_FAILED = 'DOWNLOAD_FAILED',
}

/**
 * Resource status (shared across pipelines, models, etc.)
 * @see packages/domains/src/enums/generated/ResourceStatusType.ts
 */
export enum ResourceStatus {
  ENABLED = 'ENABLED',
  DISABLED = 'DISABLED',
  ARCHIVED = 'ARCHIVED',
  DELETED = 'DELETED',
}

// =============================================================================
// Streaming Session Types
// =============================================================================

/**
 * Request body for creating a streaming session.
 *
 * @see POST /api/v1/transcription-jobs/stream/session
 * @see apps/api/src/modules/stt-v2/dto/create-streaming-session.request.ts
 */
export interface CreateStreamingSessionRequest {
  /** Pipeline UUID or slug (required) */
  pipelineId: string;
  /** Optional consultation to link the session to */
  consultationId?: string;
  /** Audio sample rate in Hz (8000-48000, default: 16000) */
  sampleRate?: number;
  /** ISO 639-1 language code (e.g., "en", "th") */
  language?: string;
  /** Enable multilingual code-switching */
  codeSwitching?: boolean;
  /** Enable speaker diarization */
  diarization?: boolean;
  /** Microphone device identifier */
  microphoneId?: string;
}

/**
 * Response from creating a streaming session.
 *
 * @see POST /api/v1/transcription-jobs/stream/session
 */
export interface StreamingSessionResponse {
  /** Unique session identifier */
  sessionId: string;
  /** Session status */
  status: StreamingSessionStatus;
  /** Maximum concurrent streaming sessions allowed */
  maxConcurrent: number;
  /** Currently active streaming sessions */
  currentActive: number;
  /** WebSocket URL path for connecting */
  wsUrl: string;
}

/**
 * Streaming session status values.
 *
 * @see packages/applications/src/services/stt/streaming/dto/streaming-session.dto.ts
 */
export type StreamingSessionStatus = 'active' | 'finalizing' | 'closed' | 'rejected';

// =============================================================================
// WebSocket Protocol Types (Client → Server)
// =============================================================================

/**
 * Audio frame sent from client to server via WebSocket.
 * Alternative to sending raw binary PCM buffers.
 */
export interface WsAudioFrame {
  type: 'audio';
  /** Sequence number for ordering */
  seq: number;
  /** Base64-encoded PCM audio data (int16 LE, mono) */
  data: string;
  /** Optional microphone device identifier */
  microphoneId?: string;
}

/**
 * Stop signal — tells server to finalize current transcription.
 */
export interface WsStopMessage {
  type: 'stop';
}

/**
 * Close signal — tells server to close the session.
 */
export interface WsCloseMessage {
  type: 'close';
}

/**
 * Union of all client-to-server WebSocket messages.
 * Note: Binary PCM buffers can also be sent directly (not represented here).
 */
export type WsClientMessage = WsAudioFrame | WsStopMessage | WsCloseMessage;

// =============================================================================
// WebSocket Protocol Types (Server → Client)
// =============================================================================

/**
 * Transcript result from server.
 *
 * @see apps/api/src/modules/stt-v2/dto/streaming-protocol.dto.ts
 */
export interface WsTranscriptResult {
  type: 'transcript';
  /** Transcribed text */
  text: string;
  /** Start time in seconds from session start */
  startTime: number;
  /** End time in seconds from session start */
  endTime: number;
  /** Whether this is a final (committed) transcript */
  isFinal: boolean;
  /** English translation for code-switching output, if available */
  englishText?: string;
  /** Speaker identifier from diarization, if available */
  speakerId?: string;
  /** Human-readable speaker label, if provided by backend */
  speakerLabel?: string;
  /** Speaker identification confidence (0-1) */
  speakerConfidence?: number;
  /** Optional speaker embedding vector (JSON-serializable) */
  speakerEmbedding?: number[];
  /** Optional speaker feature metadata from backend */
  speakerFeatures?: Record<string, unknown>;
  /** Word-level timestamps with confidence scores */
  wordTimestamps?: WsWordTimestamp[];
  /** Backend inference/processing time in seconds */
  inference?: number;
}

/**
 * Word-level timestamp from server transcript.
 */
export interface WsWordTimestamp {
  /** The word text */
  word: string;
  /** Start time in seconds from session start */
  start: number;
  /** End time in seconds from session start */
  end: number;
  /** Confidence score (0-1) */
  confidence: number;
}

/**
 * Status update from server.
 */
export interface WsStatusMessage {
  type: 'status';
  /** Status identifier (e.g., 'connected', 'finalizing', 'closed') */
  status: string;
  /** Human-readable status message */
  message: string;
}

/**
 * Error message from server.
 */
export interface WsErrorMessage {
  type: 'error';
  /** Machine-readable error code */
  code: string;
  /** Human-readable error description */
  message: string;
}

/**
 * Union of all server-to-client WebSocket messages.
 */
export type WsServerMessage = WsTranscriptResult | WsStatusMessage | WsErrorMessage;

// =============================================================================
// Transcription Job Types
// =============================================================================

/**
 * Transcription job response from backend.
 *
 * @see packages/applications/src/services/stt/job/dto/job.response.ts
 */
export interface TranscriptionJobResponse {
  /** Unique job identifier */
  id: string;
  /** Job type (BATCH or STREAMING) */
  jobType: TranscriptionJobType;
  /** ASR pipeline ID used for this job */
  pipelineId: string;
  /** Job status */
  status: TranscriptionJobStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Number of retry attempts */
  retryCount: number;
  /** Maximum allowed retries */
  maxRetries: number;
  /** Tenant ID */
  tenantId: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Linked consultation ID */
  consultationId?: string | null;
  /** Linked context item ID */
  contextItemId?: string | null;
  /** Linked media ID */
  mediaId?: string | null;
  /** When the job was queued (ISO 8601) */
  queuedAt?: string | null;
  /** When the job started processing (ISO 8601) */
  startedAt?: string | null;
  /** When the job completed (ISO 8601) */
  completedAt?: string | null;
  /** Final transcription text */
  resultText?: string | null;
  /** Additional result metadata (e.g., confidence scores) */
  resultMetadata?: Record<string, unknown> | null;
  /** Error message if job failed */
  errorMessage?: string | null;
  /** Error code if job failed */
  errorCode?: string | null;
  /** Worker that processed this job */
  workerId?: string | null;
  /** User who created the job */
  createdBy?: string | null;
  /** Nested pipeline response (if included) */
  pipeline?: AsrPipelineResponse;
}

/**
 * Aggregated job status counts.
 *
 * @see packages/applications/src/services/stt/job/dto/job.response.ts
 */
export interface TranscriptionJobStatusCounts {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  cancelled: number;
  dead: number;
}

// =============================================================================
// ASR Pipeline Types
// =============================================================================

/**
 * ASR pipeline response from backend.
 *
 * @see packages/applications/src/services/stt/pipeline/dto/pipeline.response.ts
 */
export interface AsrPipelineResponse {
  /** Unique pipeline identifier */
  id: string;
  /** Pipeline display name */
  name: string;
  /** URL-friendly slug */
  slug: string;
  /** Optional description */
  description?: string | null;
  /** YAML configuration content */
  configYaml: string;
  /** Resource status (ENABLED, DISABLED, etc.) */
  resourceStatus: ResourceStatus;
  /** Associated tags */
  tags: string[];
  /** Tenant ID */
  tenantId: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Created by user ID */
  createdBy?: string | null;
  /** Updated by user ID */
  updatedBy?: string | null;
}

// =============================================================================
// AI Model Types
// =============================================================================

/**
 * AI model response from backend.
 *
 * @see packages/applications/src/services/stt/model/dto/model.response.ts
 */
export interface AiModelResponse {
  /** Unique model identifier */
  id: string;
  /** Model display name */
  name: string;
  /** URL-friendly slug */
  slug: string;
  /** Optional description */
  description?: string | null;
  /** Model category (AUDIO, NLP, VISION, etc.) */
  category: string;
  /** Task type (AUTOMATIC_SPEECH_RECOGNITION, TOKEN_CLASSIFICATION, etc.) */
  taskType: string;
  /** Model type (BASE_MODEL, FINETUNED_MODEL, QUANTIZED_MODEL) */
  modelType: string;
  /** Source registry (HUGGINGFACE, GITHUB, MLFLOW, LOCAL) */
  source: string;
  /** Source URI (e.g., HuggingFace model ID) */
  sourceUri: string;
  /** Source revision / version tag */
  sourceRevision?: string | null;
  /** Model format (SAFETENSOR, ONNX, NEMO, PYTORCH) */
  format: string;
  /** Estimated memory usage in MB */
  memorySizeMb?: number | null;
  /** Compute type requirement (e.g., 'gpu', 'cpu') */
  computeType?: string | null;
  /** Download status */
  downloadStatus: AiModelDownloadStatus;
  /** Local file path (if downloaded) */
  localPath?: string | null;
  /** When the model was downloaded (ISO 8601) */
  downloadedAt?: string | null;
  /** File size in MB */
  fileSizeMb?: number | null;
  /** File checksum */
  checksum?: string | null;
  /** Resource status (ENABLED, DISABLED, etc.) */
  resourceStatus: ResourceStatus;
  /** Associated tags */
  tags: string[];
  /** Tenant ID */
  tenantId: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
  /** Last update timestamp (ISO 8601) */
  updatedAt: string;
  /** Created by user ID */
  createdBy?: string | null;
  /** Updated by user ID */
  updatedBy?: string | null;
}
