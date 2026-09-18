/**
 * DTOs for the streaming session management service.
 *
 * These DTOs mirror the Python STT internal API schemas and are used
 * by the StreamingSessionService to communicate with the STT service.
 */

import type { ResolvedAsrSpec } from '@arcaai/types';
import { StorageDescriptor } from '../../../baseServices/storage/providers/IBlobStorageProvider';
import type { ClippedMetadataSpan } from '../stream-metadata-timeline';

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
 * One engine's total time in a streaming session — one `transcribe.stream`
 * ledger row.
 *
 * TASK-874 — a session can change ASR engines mid-flight (auto on a classified
 * outage, or manually in either direction), and fallback to the platform default
 * is a METERED platform HA capability, so billing follows ENGINE-TIME: the
 * tenant's BYO minutes meter `BYOK` and the platform fallback's meter `CLOUD`.
 * `deployment` is DERIVED by `apps/stt` from the credential row that actually
 * served the span — never stamped by a call site. Segments are aggregated per
 * `(engine, deployment)` and sum exactly to the summary's own
 * `audio_seconds` / `session_seconds`.
 */
export interface StreamingUsageSegment {
  /** Usage-ledger engine id that served this segment. */
  engine: string;
  /** `SELF_HOSTED` | `CLOUD` | `BYOK`, derived from the row that served. */
  deployment: string;
  audio_seconds: number;
  session_seconds: number;
  /**
   * TASK-958 D-7 — the `AiProviderConnection` this stretch authenticated as.
   *
   * A tenant may hold two accounts of one vendor, so `engine` no longer identifies
   * the credential that was spent, and `apps/stt` aggregates segments by
   * `(engine, deployment, connection_id)` for that reason. Absent/`null` from a
   * platform engine and from a worker that predates the field.
   */
  connection_id?: string | null;

  // TASK-959 §3.2/§4.2 — the compute and network halves, PER SEGMENT.
  //
  // `UsageSegment.to_dict()` dumps every one of these, so on the wire they are
  // present-and-null rather than absent on a leg they do not apply to; only an
  // STT that predates the fields sends none. NOTE this shape reaches the emitter
  // by TWO paths and only one of them is validated: the reaper push-back goes
  // through `SttStreamingUsagePushbackRequest`, but the DELETE-teardown response
  // is read straight off the HTTP body. So `device` is re-checked against the
  // ledger's own vocabulary at emission, not trusted because it is typed here.
  /** ASR-only seconds on THIS engine — a `GPU_SECOND` or `CPU_SECOND` row, per `device`. */
  processing_seconds?: number;
  /** `cuda` | `mps` | `cpu`, resolved per segment: a cloud leg occupied THIS service's CPU. */
  device?: string;
  /** Bytes moved to/from a third party. `null` — never `0` — on a self-hosted engine. */
  request_bytes?: number | null;
  response_bytes?: number | null;
  /** `wire` (real HTTP) or `app` (an application-level proxy). `null` alongside null counts. */
  byte_source?: string | null;
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
  /**
   * TASK-958 D-7 — the connection the LAST-loaded engine authenticated as, beside
   * the `engine`/`deployment` scalars it belongs with. The per-segment field above
   * is the exact answer; this one stands in for a sender that reports no segments.
   */
  connection_id?: string | null;
  /**
   * TASK-874 — the per-engine breakdown, one ledger row each. ADDITIVE to the
   * scalars above (which stay the LAST-loaded engine), so an STT that predates
   * it simply omits the field and the gateway meters from the scalars exactly
   * as before.
   */
  segments?: StreamingUsageSegment[];
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

/**
 * TASK-951 R2 (D-8) — what a stream session echoes back to its client.
 *
 * The client declares `context` when it CREATES the session
 * (`CreateStreamSessionRequest.context`); the gateway stamps `sessionEpochMs`
 * at the same moment. Both are stored on the gateway-side session binding, read
 * ONCE at WS attach, and attached to every transcript of that session — never
 * forwarded to `apps/stt`, which knows nothing about either.
 *
 * The pair travels TOGETHER on purpose. A session that declared no `context`
 * gets neither field, so its transcript wire is byte-identical to the one every
 * client parses today; the epoch is only useful to a caller that is aligning
 * several sessions, and such a caller is exactly the one that declares a
 * context.
 */
export interface StreamSessionEcho {
  /** Verbatim client-declared session context (`{ [kindKey]: payload }`). */
  context?: Record<string, unknown>;
  /** Epoch milliseconds at session creation — segment times are relative to it. */
  sessionEpochMs?: number;
  /**
   * TASK-951 R2 (clarified) — the session's LIVE metadata timeline, read at EMIT time.
   *
   * A function, not a value, and that is the whole design. `context` above is fixed for the
   * life of the session, so it is read once and handed over. The metadata spans are not: a
   * client changes which microphones are live WHILE it records, so a snapshot taken when the
   * subscription was created would stamp every later segment with the set that happened to be
   * in force at attach — exactly the failure the timeline exists to prevent.
   *
   * Returns the spans overlapping the segment's own `[startTime, endTime]`, already clipped to
   * it. The bridge does not know the clock, the session or Redis; it asks the caller that does.
   * Omit the accessor — as every non-caption subscriber does — and transcripts are byte-identical
   * to today.
   */
  metadataSpans?: (startTime: number, endTime: number) => ClippedMetadataSpan[];
}

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
  /**
   * TASK-985 (M-03) — wall-clock ms the ASR spent decoding THIS utterance, as reported by the
   * STT worker (`inference_ms` on the Redis result entry).
   *
   * It has been on the wire from `apps/stt` all along and the bridge parsed it into a local
   * and then dropped it, so no consumer has ever seen it. It is the one number that separates
   * "the model is slow" from "the transport is slow" — without it, a client, a dashboard and
   * an operator watching the same slow caption cannot tell a GPU under contention from a
   * congested Redis relay. Absent from an older worker that does not stamp it.
   */
  inferenceMs?: number;
  /**
   * TASK-951 R2 — the session's client-declared context, echoed VERBATIM.
   *
   * The object the client sent to `POST audio/transcription-jobs/stream/session`
   * as `context` (`{ [kindKey]: payload }`), unchanged. It is per-SESSION, not
   * per-segment: one standalone session per microphone is how a caller gets
   * per-mic attribution without HOPE's mixer or diarization knowing about it
   * (D-8 / OD-8). Absent for a session that declared none.
   */
  context?: Record<string, unknown>;
  /**
   * TASK-951 R2 — epoch milliseconds at session creation.
   *
   * `sessionEpochMs + startTime * 1000` is the wall-clock instant of a segment,
   * which is what lets a caller interleave several concurrent sessions whose
   * `startTime`s are each relative to their own session. Travels with
   * {@link StreamingTranscriptMessage.context} ({@link StreamSessionEcho}).
   */
  sessionEpochMs?: number;
  /**
   * TASK-951 R2 (clarified 2026-09-11) — the client's own metadata in force over THIS segment's
   * audio, VERBATIM and flat: the shape the v1 pipeline echoed, so an integrator's labelling code
   * reads `metadata.mic_id` exactly as it did. Declared with a `{ type: 'metadata' }` frame (or
   * inline on a JSON audio frame) and STICKY until the next declaration — a frame that declares
   * nothing inherits the last one.
   *
   * When the client switched metadata mid-segment, this is the value in force over the LARGER
   * share of the segment (a tie goes to the earlier); the exact bounds are in
   * {@link StreamingTranscriptMessage.metadataSpans}. HOPE never interprets the object.
   *
   * ABSENT for a session that never sent a `metadata` frame, which is what keeps the wire
   * byte-identical for every client that does not use this. Independent of
   * {@link StreamingTranscriptMessage.context}: that is what the session IS, this is what was
   * happening while it recorded.
   */
  metadata?: Record<string, unknown>;
  /**
   * TASK-951 R2 (clarified) — the same declarations, TIME-SYNCED within this segment.
   *
   * Each entry is a stretch of THIS segment's audio and the metadata object that was in force
   * over it, in time order, both bounds already clipped to `[startTime, endTime]` — so a consumer
   * never has to know the session's clock, only this segment's. One entry means one object
   * covered the whole segment; two or more mean the client switched mid-utterance, and a consumer
   * that wants to split the segment at the switch can. Present exactly when `metadata` is.
   */
  metadataSpans?: ClippedMetadataSpan[];
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
