/**
 * TASK-933 — the STT STREAMING-SESSION contract: the three ordinary HTTP routes
 * that open, re-ticket and close a session, plus the `/ws/stt/stream` wire
 * protocol {@link RealtimeSttSocket} speaks.
 *
 * Mirrored from `apps/api/src/modules/streaming/dto/transcription-job.dto.ts`
 * (the session half) and `packages/agentic-sdk-v2/src/types/stt.ts` (the WS
 * half). Hand-mirrored rather than imported: `@arcaai/vox` is a BROWSER package
 * with React and an audio/ML stack as peers, and this package has zero runtime
 * dependencies — importing its types would drag it into this build graph.
 *
 * ## What this is NOT
 *
 * This is a socket client for a wire protocol. It is not an audio pipeline:
 * there is no capture, no VAD, no denoise and no model — the browser rule
 * ("the browser never runs a model") is a statement about where INFERENCE
 * happens, and it holds here too. What a server-side integrator brings is
 * PCM16 frames from wherever they already have them.
 */

/**
 * Body of `POST /api/v1/audio/transcription-jobs/stream/session`.
 *
 * Every field is optional. Sending `{}` is the intended default: the gateway
 * resolves the tenant's ASSIGNED ASR agent through the department → tenant
 * cascade, which is the selection HOPE wants an integration to use.
 */
export interface CreateStreamSessionRequest {
  /**
   * Lineage slug of a published `SPEECH_TO_TEXT` agent visible to the tenant.
   * Omit it to use the assigned agent. A slug the tenant cannot see is a 404.
   *
   * This — never a model id, never an engine name — is how ASR is selected.
   */
  agentSlug?: string;
  /**
   * @deprecated Removed in R4. The gateway still honours it and answers with
   * `Deprecation` headers. Name {@link agentSlug} instead, or send neither.
   */
  pipelineId?: string;
  /** Link the session to a consultation, so its transcript lands on that record. */
  consultationId?: string;
  /** Hz. Default 16000 server-side; the negotiated value is what the gateway forwards to STT. */
  sampleRate?: number;
  /** ISO 639-1 override (`en`, `ml`). {@link languageMode} takes precedence. */
  language?: string;
  /**
   * End-user language mode id — `'en'`, `'ml'`, `'ml-en'` (code-switch),
   * `'auto'`. Resolved by STT against the session engine: a mode no configured
   * engine can serve is a 422, not a silent downgrade.
   */
  languageMode?: string;
  /** `'fallback'` opens directly on the tenant's default provider. Fail-closed: no fallback configured ⇒ 409. */
  startOn?: 'primary' | 'fallback';
  /**
   * Number of distinct microphone SOURCES mixed into the session (1-8).
   * A usage-repricing signal, NOT a PCM channel count — the uplink is always
   * mono. Default 1.
   */
  channelCount?: number;
  /**
   * Client-owned identification of THIS session, `{ [kindKey]: payload }` —
   * the same envelope shape as `OpenConsultationRequest.context` (TASK-951).
   * At most 4 KB serialized. When the resolved ASR agent binds a context
   * schema (`Agent.contextSchemaId`), each kind is validated against that
   * agent's FROZEN `compiledConfig.contextSchema`: a violation is 400
   * `CONTEXT_SCHEMA_VIOLATION`, oversize is 413 `CONTEXT_TOO_LARGE`. Without a
   * bound schema, any object at or under the size cap is accepted as-is.
   *
   * Echoed VERBATIM on {@link StreamSessionResponse.context} and on every
   * {@link SttTranscriptResult.context} of this session — this is the
   * mechanism for running several UNMIXED sessions (one per microphone) and
   * later re-associating each transcript with the source that produced it,
   * without keeping an out-of-band map.
   */
  context?: Record<string, unknown>;
}

/** Lifecycle of a streaming session. */
export type StreamingSessionStatus = 'active' | 'finalizing' | 'closed' | 'rejected';

/**
 * Response of `POST …/stream/session`. Mirrors `StreamSessionResponse`.
 *
 * `ticket` is SINGLE-USE and consumed at the WebSocket handshake — every
 * reconnect needs a fresh one from {@link SttResource.refreshTicket}. That is
 * the whole reason {@link RealtimeSttSocket} takes a refresher rather than a
 * ticket string.
 */
export interface StreamSessionResponse {
  sessionId: string;
  status: StreamingSessionStatus | string;
  /** Gateway-relative WS path, normally `/ws/stt/stream`. */
  wsUrl: string;
  maxConcurrent: number;
  currentActive: number;
  /** Single-use, consumed on first WS open. */
  ticket: string;
  /** Epoch milliseconds. */
  ticketExpiresAt: number;
  /** The runtime key the session opened with: the ASR agent VERSION id (agent path). */
  pipelineId?: string;
  /** The agent the session resolved to — echoed even when the caller named none. */
  agentSlug?: string;
  agentVersionId?: string;
  /** Engine live at create; `'fallback'` when the primary could not load or was not asked for. */
  activeEngine?: 'primary' | 'fallback';
  voiceProfileSeeded?: boolean;
  /** Echoed verbatim from {@link CreateStreamSessionRequest.context}, when the request carried one. */
  context?: Record<string, unknown>;
  /**
   * Epoch milliseconds at which the gateway attached this session's clock.
   * `sessionEpochMs + segment.startTime * 1000` is the wall-clock anchor for
   * aligning segments across sessions opened moments apart from each other —
   * e.g. several per-microphone sessions for one consultation.
   */
  sessionEpochMs: number;
}

/** Response of `POST …/stream/session/:sessionId/refresh-ticket`. */
export interface StreamTicketRefreshResponse {
  ticket: string;
  /** Epoch milliseconds. */
  ticketExpiresAt: number;
}

// -----------------------------------------------------------------------------
// `/ws/stt/stream` — client → server
// -----------------------------------------------------------------------------

/**
 * A JSON-framed audio chunk. The BINARY frame is the primary path (and what
 * {@link RealtimeSttSocket.sendPcm16} sends): the gateway routes on the
 * WebSocket `isBinary` flag, so a binary frame is audio and a text frame is
 * control, with no ambiguity and no base64 inflation.
 */
export interface SttAudioFrame {
  type: 'audio';
  seq: number;
  /** Base64 PCM16 LE mono. */
  data: string;
  microphoneId?: string;
}

/** Finalize the current utterance. The session stays open. */
export interface SttStopMessage {
  type: 'stop';
}

/** End the session. The gateway finalizes upstream immediately — no grace window. */
export interface SttCloseMessage {
  type: 'close';
}

/**
 * The resume handshake, sent on a FRESH socket after a drop.
 * `lastSeq` is the highest transcript `seq` the client actually observed; the
 * server replays everything above it and nothing at or below it.
 */
export interface SttResumeRequest {
  type: 'resume';
  sessionId: string;
  lastSeq: number;
}

export type SttClientMessage = SttAudioFrame | SttStopMessage | SttCloseMessage | SttResumeRequest;

// -----------------------------------------------------------------------------
// `/ws/stt/stream` — server → client
// -----------------------------------------------------------------------------

/** Word-level timing, when the engine reports it. */
export interface SttWordTimestamp {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

/** One transcript segment (or a `gloss` follow-up translating one). */
export interface SttTranscriptResult {
  type: 'transcript';
  text: string;
  /** Seconds from session start. */
  startTime: number;
  endTime: number;
  /** `false` = a revisable partial. */
  isFinal: boolean;
  /** Committed-prefix length of `text` on a partial: characters before it will not be revised. */
  stableChars?: number;
  utteranceIndex?: number;
  /** Absent means `'segment'`. A `'gloss'` reuses the index of the final it translates. */
  resultType?: 'segment' | 'gloss';
  /** Monotonic server sequence — what {@link SttResumeRequest.lastSeq} is built from. */
  seq?: number;
  englishText?: string;
  /** Per-utterance detected language, when the engine reports one. */
  language?: string;
  speakerId?: string;
  speakerLabel?: string;
  speakerConfidence?: number;
  wordTimestamps?: SttWordTimestamp[];
  inference?: number;
  /** Per-utterance provenance: can differ from the session's after a mid-session engine switch. */
  pipelineId?: string;
  /** Echoed verbatim from the session's {@link CreateStreamSessionRequest.context}, when it carried one. */
  context?: Record<string, unknown>;
  /** This segment's session {@link StreamSessionResponse.sessionEpochMs}, repeated for convenience. */
  sessionEpochMs?: number;
  [key: string]: unknown;
}

/**
 * A status update. `provider_switched` is the one to actually branch on — it
 * reports an ASR engine swap mid-session, with the snake_case passthrough
 * fields the gateway relays verbatim.
 */
export interface SttStatusMessage {
  type: 'status';
  /** e.g. `connected`, `finalizing`, `closed`, `provider_switched`. */
  status: string;
  message?: string;
  from_pipeline?: string;
  to_pipeline?: string;
  reason?: string;
  utterance_index?: number | string;
  active?: 'primary' | 'fallback';
  is_fallback?: boolean;
  [key: string]: unknown;
}

/** A server-side error on the session. Does NOT necessarily close the socket. */
export interface SttErrorMessage {
  type: 'error';
  code: string;
  message: string;
}

/** The resume was accepted; replay of `seq > lastSeq` follows. */
export interface SttResumedMessage {
  type: 'resumed';
  sessionId: string;
  /** First seq about to be replayed (`lastSeq + 1`). */
  fromSeq: number;
}

/**
 * The resume could NOT be satisfied. `buffer_overflow` means the requested
 * `lastSeq` fell out of the bounded replay buffer — the gap is real and cannot
 * be recovered by asking again.
 */
export interface SttResumeFailedMessage {
  type: 'resume_failed';
  sessionId: string;
  reason: 'buffer_overflow' | 'unknown_session' | string;
  minAvailableSeq?: number;
}

export type SttServerMessage = SttTranscriptResult | SttStatusMessage | SttErrorMessage | SttResumedMessage | SttResumeFailedMessage;
