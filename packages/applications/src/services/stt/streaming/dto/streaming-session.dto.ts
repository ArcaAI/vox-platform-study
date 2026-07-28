/**
 * DTOs for the streaming session management service.
 *
 * These DTOs mirror the Python STT internal API schemas and are used
 * by the StreamingSessionService to communicate with the STT service.
 */

import { StorageDescriptor } from '../../../baseServices/storage/providers/IBlobStorageProvider';

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
  /** Override pipeline language (ISO 639-1 code) */
  language?: string;
  /** Tenant-scoped audio bucket name forwarded to STT-v2 for storage isolation */
  audioBucketName?: string;
  /**
   * Per-tenant storage descriptor forwarded to STT-v2 so a DEDICATED (S3/Azure)
   * tenant's worker connects to the right backend. Omitted/undefined for SHARED
   * tenants — the worker uses its env-default client + `audioBucketName`.
   */
  storage?: StorageDescriptor | null;
  /**
   * Decrypted per-tenant BYO provider credentials (TASK-567). Held by the
   * apps/stt session runtime IN MEMORY ONLY — never persisted, never logged.
   * snake_case entries match the Python wire shape:
   * `{[provider]: {api_key, region?, base_url?, endpoint?, model?}}`.
   */
  providerOverrides?: Record<string, { api_key: string; region?: string; base_url?: string; endpoint?: string; model?: string }>;
  /**
   * Tenant-level default fallback pipeline id (TASK-567). Forwarded so the
   * session runtime can lazily resolve + swap to the fallback ASR engine on a
   * classified outage without tearing the WebSocket.
   */
  fallbackPipelineId?: string | null;
}

// ---------------------------------------------------------------------------
// Responses (from STT internal API)
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
  /**
   * Committed-prefix length of `text` on partial results
   * (stt local-agreement gate). Absent on finals and on older stt
   * workers that don't emit the field.
   */
  stableChars?: number;
  /**
   * Utterance ordinal stamped by stt on every
   * segment result; gloss results carry the same index as the final they
   * translate. Absent on older workers.
   */
  utteranceIndex?: number;
  /**
   * Result kind from the wire `type` field:
   * 'segment' (default; absence means segment) or 'gloss' (a post-final
   * English translation carrying `englishText`).
   */
  resultType?: 'segment' | 'gloss';
  /** English translation for code-switching output, if available */
  englishText?: string;
  /** Speaker identifier from diarization, if available */
  speakerId?: string;
  /**
   * Human-readable speaker label derived ONCE from `speakerId` by
   * the streaming bridge ({@link deriveSpeakerLabel}). Anonymous (`"Speaker 0"`
   * / `"Unknown speaker"`) — never a raw clinician/patient name. Consumers
   * render this and fall back to `speakerId`; they do NOT re-derive it.
   */
  speakerLabel?: string;
  /** Speaker identification confidence (0-1) */
  speakerConfidence?: number;
  /** Per-word timestamps, if enabled in pipeline config */
  wordTimestamps?: Array<{ word: string; start: number; end: number; confidence: number | null }>;
}

export interface StreamingStatusMessage {
  type: 'status';
  /** Session status (e.g. 'finalizing', 'closed', 'provider_switched') */
  status: string;
  /**
   * Human-readable message. Optional: structured status results (the
   * `provider_switched` ASR-engine swap, TASK-567) carry typed fields below
   * instead of prose.
   */
  message?: string;
  // ---- provider_switched passthrough (TASK-567 §3.4) ----
  // apps/stt publishes an in-session engine swap as a `status` result; the
  // bridge relays these snake_case fields verbatim (the wire contract the SDK
  // client reads). Present only when `status === 'provider_switched'`.
  /** Pipeline the session switched away from. */
  from_pipeline?: string;
  /** Pipeline the session is now transcribing on (the fallback). */
  to_pipeline?: string;
  /** Switch trigger: 'auto' (outage/exception) or 'user' (clinician-initiated). */
  reason?: string;
  /** Utterance ordinal at which the swap happened. */
  utterance_index?: number;
}

export interface StreamingErrorMessage {
  type: 'error';
  /** Error code */
  code: string;
  /** Human-readable error message */
  message: string;
}

export type StreamingServerMessage = StreamingTranscriptMessage | StreamingStatusMessage | StreamingErrorMessage;
