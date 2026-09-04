/**
 * DTOs for the streaming session management service.
 *
 * These DTOs mirror the Python STT internal API schemas and are used
 * by the StreamingSessionService to communicate with the STT service.
 */

import type { ResolvedAsrSpec } from '@arcaai/types';
import { StorageDescriptor } from '../../../baseServices/storage/providers/IBlobStorageProvider';

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface CreateStreamingSessionRequest {
  /** Unique session identifier (UUID) */
  sessionId: string;
  /** Tenant identifier */
  tenantId: string;
  /**
   * The runtime identity the session is keyed on. With `resolvedSpec` this is
   * `spec.runtimeKey` (the ASR Agent VERSION id); without it, the deprecated
   * `AsrPipeline` id/slug `apps/stt` still looks up for the window.
   */
  pipelineId: string;
  /**
   * TASK-861 — the gateway-resolved ASR runtime contract. When present,
   * `apps/stt` assembles the engine chain from it and reads NOTHING from
   * Postgres; `pipelineId` / `fallbackPipelineId` are then the spec's runtime
   * keys, sent for the session-identity plumbing that predates the spec.
   */
  resolvedSpec?: ResolvedAsrSpec | null;
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
  /**
   * End-user language mode id, e.g. `'en'`, `'ml'`, `'ml-en'`
   * (Malayalam+English code-switch), `'auto'`. Forwarded to STT, which resolves
   * it against the session's engine and rejects (422) a mode no configured
   * engine can serve. Takes precedence over `language`.
   */
  languageMode?: string;
  /**
   * Pre-start default-provider selection. `'fallback'` opens the
   * session directly on the tenant-admin default (fallback) engine from frame 1
   * (the primary stays switchable back); `'primary'` (default) opens on the
   * SDK-configured pipeline. Forwarded to STT as `start_on`.
   */
  startOn?: 'primary' | 'fallback';
  /**
   * Number of distinct microphone SOURCES mixed into this session.
   * Forwarded to STT as `channel_count` and echoed on teardown for usage
   * repricing; bills 1× (OQ2). Defaults to 1 when omitted.
   */
  channelCount?: number;
  /** Tenant-scoped audio bucket name forwarded to STT-v2 for storage isolation */
  audioBucketName?: string;
  /**
   * Per-tenant storage descriptor forwarded to STT-v2 so a DEDICATED (S3/Azure)
   * tenant's worker connects to the right backend. Omitted/undefined for SHARED
   * tenants — the worker uses its env-default client + `audioBucketName`.
   */
  storage?: StorageDescriptor | null;
  /**
   * Decrypted per-tenant BYO provider credentials. Held by the
   * apps/stt session runtime IN MEMORY ONLY — never persisted, never logged.
   * snake_case entries match the Python wire shape:
   * `{[provider]: {api_key, region?, base_url?, endpoint?, model?}}`.
   */
  providerOverrides?: Record<string, { api_key: string; region?: string; base_url?: string; endpoint?: string; model?: string }>;
  /**
   * The fallback engine's runtime key (`resolvedSpec.fallback.spec.runtimeKey`),
   * or — deprecated, TASK-861 — the tenant-level fallback `AsrPipeline` id.
   * Forwarded so the session runtime can swap to the fallback ASR engine on a
   * classified outage without tearing the WebSocket.
   */
  fallbackPipelineId?: string | null;
  /**
   * Tenant governance for the FAILURE-DRIVEN auto switch. Omitted /
   * `null` ⇒ STT's `EngineSwitchController` default (enabled). Never governs a
   * user-initiated switch — that is an explicit choice, not a policy.
   */
  autoSwitchEnabled?: boolean | null;
  /**
   * Tenant governance for how many consecutive threshold-class utterance
   * failures arm the auto switch. Omitted / `null` ⇒ STT default (2).
   */
  consecutiveFailureThreshold?: number | null;
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
  /**
   * The RESOLVED ASR pipeline this session opened with. Differs from
   * the requested id whenever the caller sent none (STT/gateway resolve one) or
   * a slug resolved to a different identifier. `undefined` against an STT that
   * predates the echo.
   */
  pipelineId?: string;
  /**
   * The engine actually live at create: `'primary'`, or `'fallback'` when the
   * session opened on the tenant fallback — by choice (`startOn`) or because
   * the primary ASR failed to load. `undefined` against an older STT.
   */
  activeEngine?: 'primary' | 'fallback';
}

/**
 * A selectable STT language mode + the catalog-wide set of engines that can
 * serve it. Mirrors the STT `/internal/streaming/language-modes`
 * payload. `kind` distinguishes a single language, a bilingual code-switch
 * mode, and auto-detect.
 */
export interface SttLanguageMode {
  id: string;
  label: string;
  kind: 'single' | 'code_switch' | 'auto';
  primaryLanguage: string | null;
  secondaryLanguage: string | null;
  /** Engine `format` values (catalog-wide) that can serve this mode. */
  supportedEngines: string[];
}

export interface SttLanguageModeCatalog {
  modes: SttLanguageMode[];
}

/**
 * The usage-attribution summary a REAL session teardown
 * returns (`StreamingSessionTeardownResponse` in `apps/stt`). Kept in the
 * WIRE (snake_case) shape rather than mapped to camelCase: this is read
 * exactly once, inside `StreamingSessionService.removeSession`, to build the
 * `transcribe.stream` ledger event, and is never exposed to any other
 * consumer. `undefined`/absent on the idempotent "already gone" 204 branch.
 */
export interface StreamingSessionTeardownSummary {
  session_id: string;
  tenant_id: string;
  consultation_id: string | null;
  user_id: string | null;
  pipeline_id: string;
  /** ISO-8601 teardown instant — the ledger event's `occurredAt`. */
  closed_at: string;
  audio_seconds: number;
  session_seconds: number;
  /** Usage-ledger engine id; `null` when no ASR model was ever resolved. */
  engine: string | null;
  /** `SELF_HOSTED` | `CLOUD` | `BYOK`; `null` alongside a `null` engine. */
  deployment: string | null;
  language_mode: string | null;
  /**
   * Distinct microphone source count echoed from STT for usage repricing.
   * Absent from an older STT ⇒ the gateway defaults it to 1.
   */
  channel_count?: number;
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
  /**
   * Per-utterance detected language (e.g. `ml-IN`) when the ASR engine reports
   * one (Sarvam/OpenAI cloud STT). Absent for engines that don't detect a
   * language. Consumers prefer this over the session-configured language/mode.
   */
  detectedLanguage?: string;
  /**
   * The ASR pipeline that actually produced THIS utterance,
   * stamped per-segment by the stt worker (`SegmentResult.pipeline_id`).
   * Can differ from the session's requested pipeline after a mid-session
   * engine switch. Absent when the upstream stt worker doesn't set it
   * (older workers, or the id is not yet known).
   */
  pipelineId?: string;
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
   * `provider_switched` ASR-engine swap) carry typed fields below
   * instead of prose.
   */
  message?: string;
  // ---- provider_switched passthrough ----
  // apps/stt publishes an in-session engine swap as a `status` result; the
  // bridge relays these snake_case fields verbatim (the wire contract the SDK
  // client reads). Present only when `status === 'provider_switched'`.
  /** Pipeline the session switched away from. */
  from_pipeline?: string;
  /** Pipeline the session is now transcribing on (the fallback). */
  to_pipeline?: string;
  /** Switch trigger: 'auto' (outage/exception) or 'user' (clinician-initiated). */
  reason?: string;
  /**
   * The now-live engine (wire field). Names the
   * side of the BIDIRECTIONAL switch, so a client can tell a return to the
   * selected pipeline from a move to the tenant default.
   */
  active?: 'primary' | 'fallback';
  /**
   * Boolean convenience flag for {@link active}. Coerced from the stream's
   * '1'/'0' string by the bridge — consumers (compat gateway, SDK) all type it
   * `boolean`, and the raw '0' string would be truthy.
   */
  is_fallback?: boolean;
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
