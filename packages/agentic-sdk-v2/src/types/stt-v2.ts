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
  /**
   * Allow mid-utterance language switching.
   *
   * Maps to `InferenceConfig.code_switching` in stt-v2 (default `false`), which is
   * normally resolved from the pipeline YAML rather than per-session.
   *
   * NOTE: the gateway body DTO (`CreateStreamSessionRequest`) does not yet whitelist
   * this field, so a value set here is rejected by the global `forbidNonWhitelisted`
   * validation pipe. Wiring it end-to-end is tracked separately.
   */
  codeSwitching?: boolean;
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
  /**
   * One-shot stream ticket. The SDK appends `?ticket=<value>`
   * to the WebSocket URL; the API gateway consumes it on first WS open and
   * the ticket becomes invalid afterwards. Optional for backward compat with
   * older API revisions that haven't shipped the ticket field yet.
   */
  ticket?: string;
  /** Epoch milliseconds when the stream ticket expires. */
  ticketExpiresAt?: number;
  /**
   * Whether the speaker voice profile was successfully preseeded
   * preseed contract). Surfaced so the SDK can short-circuit an extra
   * voice-enrollment-status round-trip.
   */
  voiceProfileSeeded?: boolean;
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
 * Resume handshake sent by the client immediately after a reconnect
 * The server uses `lastSeq` to decide whether to replay
 * buffered transcripts or respond with `resume_failed`.
 */
export interface WsResumeRequest {
  type: 'resume';
  /** Session that was previously authenticated on this WS. */
  sessionId: string;
  /** Highest transcript `seq` the client successfully observed. 0 = fresh start. */
  lastSeq: number;
}

/**
 * Union of all client-to-server WebSocket messages.
 * Note: Binary PCM buffers can also be sent directly (not represented here).
 */
export type WsClientMessage = WsAudioFrame | WsStopMessage | WsCloseMessage | WsResumeRequest;

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
  /**
   * Committed-prefix length of `text` on partial results.
   * Characters before this index passed stt-v2's local-agreement gate and
   * will not be revised; the remainder is a tentative tail. Optional for
   * backward compat with older servers that don't emit the field.
   */
  stableChars?: number;
  /**
   * Utterance ordinal stamped on every segment result
   * follow-up). Gloss results reuse the index of the final they translate,
   * which is how clients pair a gloss to its segment. Optional for
   * backward compat with older servers.
   */
  utteranceIndex?: number;
  /**
   * Result kind: 'segment' (default — absence
   * means segment) or 'gloss', a follow-up English translation published
   * after the real final with `englishText` and the same `utteranceIndex`.
   */
  resultType?: 'segment' | 'gloss';
  /**
   * Monotonic server-assigned sequence number. Used by the
   * client to track `lastReceivedSeq` for the resume handshake. Optional for
   * backward compat with older servers that don't tag transcripts.
   */
  seq?: number;
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
 * Shared transcript WIRE CONTRACT.
 *
 * The raw server→client transcript payload exactly as it arrives on the WS,
 * BEFORE normalization into the strict {@link WsTranscriptResult} consumers
 * hold. Every field is optional and each carries BOTH casings
 * (`camelCase` | `snake_case`) because the emitters — the gateway relay and
 * stt-v2 — have historically shipped either. Values are typed `unknown`: the
 * parser (`SttV2WebSocketClient.normalizeTranscript`) is the single tolerant
 * choke point that coerces/defaults them (a numeric `is_final`, an omitted
 * `start_time`, …) instead of dropping the whole caption.
 *
 * Keep this ADDITIVE and back-compatible: never promote a field to required,
 * and add new server fields here in both casings. The index signature keeps a
 * plain `JSON.parse` result assignable so `handleMessage` can hand its parsed
 * object straight in.
 */
export interface WsTranscriptWirePayload {
  /** WS envelope kind ('transcript') OR the wire result-kind ('segment' | 'gloss'). */
  type?: unknown;
  text?: unknown;
  startTime?: unknown;
  start_time?: unknown;
  endTime?: unknown;
  end_time?: unknown;
  isFinal?: unknown;
  is_final?: unknown;
  stableChars?: unknown;
  stable_chars?: unknown;
  utteranceIndex?: unknown;
  utterance_index?: unknown;
  resultType?: unknown;
  seq?: unknown;
  englishText?: unknown;
  english_text?: unknown;
  speakerId?: unknown;
  speaker_id?: unknown;
  speakerLabel?: unknown;
  speaker_label?: unknown;
  speakerConfidence?: unknown;
  speaker_confidence?: unknown;
  speakerEmbedding?: unknown;
  speaker_embedding?: unknown;
  speakerFeatures?: unknown;
  speaker_features?: unknown;
  wordTimestamps?: unknown;
  word_timestamps?: unknown;
  inference?: unknown;
  inference_time?: unknown;
  /** Absorbs any not-yet-modelled server field so `Record<string, unknown>` stays assignable. */
  [key: string]: unknown;
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
 * Server acknowledgement that a resume handshake was accepted.
 * After this message the server replays any buffered transcripts whose
 * `seq > lastSeq`.
 */
export interface WsResumedMessage {
  type: 'resumed';
  sessionId: string;
  /** First seq the server is about to replay. */
  fromSeq: number;
}

/**
 * Server response when it cannot satisfy the resume request.
 * Typical reasons: requested `lastSeq` is older than the bounded buffer,
 * the session is unknown, or the session belongs to a different client.
 */
export interface WsResumeFailedMessage {
  type: 'resume_failed';
  sessionId: string;
  reason: 'buffer_overflow' | 'unknown_session';
  /** Lowest seq the server still has in its buffer, if known. */
  minAvailableSeq?: number;
}

/**
 * Union of all server-to-client WebSocket messages.
 */
export type WsServerMessage = WsTranscriptResult | WsStatusMessage | WsErrorMessage | WsResumedMessage | WsResumeFailedMessage;

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
