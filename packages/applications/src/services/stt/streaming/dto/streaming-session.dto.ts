/**
 * DTOs for the streaming session management service.
 *
 * These DTOs mirror the Python STT-V2 internal API schemas and are used
 * by the StreamingSessionService to communicate with the STT-V2 service.
 */

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface CreateStreamingSessionRequest {
  /** Unique session identifier (UUID) */
  sessionId: string;
  /** Tenant identifier */
  tenantId: string;
  /** ASR pipeline identifier (UUID or slug) */
  pipelineId: string;
  /** Optional consultation context */
  consultationId?: string;
  /** Audio sample rate in Hz (default 16000) */
  sampleRate?: number;
  /** Identifier for the microphone device */
  microphoneId?: string;
  /** Authenticated user ID for speaker pre-seeding */
  userId?: string;
}

// ---------------------------------------------------------------------------
// Responses (from STT-V2 internal API)
// ---------------------------------------------------------------------------

export interface StreamingSessionStatus {
  /** Session identifier */
  sessionId: string;
  /** Session status */
  status: 'active' | 'finalizing' | 'closed' | 'rejected';
  /** Rejection reason (e.g. 'at_capacity') */
  reason?: string;
  /** Maximum concurrent sessions for the worker */
  maxConcurrent: number;
  /** Number of currently active sessions */
  currentActive: number;
}

export interface StreamingAvailability {
  /** Whether the streaming module is initialized and has capacity */
  available: boolean;
  /** Module status: ready, not_initialized, at_capacity */
  status: string;
  /** Maximum concurrent sessions */
  maxConcurrent: number;
  /** Currently active sessions */
  currentActive: number;
  /** Remaining available slots */
  availableSlots: number;
}

// ---------------------------------------------------------------------------
// WebSocket protocol messages (client ↔ gateway)
// ---------------------------------------------------------------------------

export type StreamingClientMessageType = 'audio' | 'stop' | 'close';

export interface StreamingAudioMessage {
  type: 'audio';
  /** Sequence number (monotonic) */
  seq: number;
  /** Microphone identifier */
  microphoneId?: string;
  /** Base64-encoded PCM audio data */
  data: string;
}

export interface StreamingStopMessage {
  type: 'stop';
}

export interface StreamingCloseMessage {
  type: 'close';
}

export type StreamingClientMessage = StreamingAudioMessage | StreamingStopMessage | StreamingCloseMessage;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export type StreamingServerMessageType = 'transcript' | 'status' | 'error';

export interface StreamingTranscriptMessage {
  type: 'transcript';
  /** Transcribed text */
  text: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Whether this is a finalized segment */
  isFinal: boolean;
  /** English translation for code-switching output, if available */
  englishText?: string;
  /** Speaker identifier from diarization, if available */
  speakerId?: string;
  /** Speaker identification confidence (0-1) */
  speakerConfidence?: number;
  /** Per-word timestamps, if enabled in pipeline config */
  wordTimestamps?: Array<{ word: string; start: number; end: number; confidence: number | null }>;
}

export interface StreamingStatusMessage {
  type: 'status';
  /** Session status */
  status: string;
  /** Human-readable message */
  message: string;
}

export interface StreamingErrorMessage {
  type: 'error';
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
}

export type StreamingServerMessage = StreamingTranscriptMessage | StreamingStatusMessage | StreamingErrorMessage;
