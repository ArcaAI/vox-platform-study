import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ASR_DEGRADATION_CODES, LanguageResolutionResponse } from '@arcaai/applications';
import type { AsrDegradationCode, AsrDegradedStage, AsrSessionWarning } from '@arcaai/applications';
import { IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export const AUDIO_BUCKET = 'hope-audio';

/**
 * STATIC hard ceiling for the multipart interceptor.
 *
 * A `@UseInterceptors` decorator is evaluated once at class definition, so it
 * cannot read the per-tenant `stt.batch.maxFileSizeMb` knob. This bound exists
 * only to stop a multi-gigabyte body from being buffered before the handler can
 * apply the CONFIGURED limit — it is deliberately far above it.
 *
 * It replaces the former `MAX_FILE_SIZE = 100 MB`, which was the only bound the
 * route had and rejected a legitimate 60-minute 16 kHz mono WAV (~115 MB).
 */
export const MAX_UPLOAD_HARD_CEILING = 1024 * 1024 * 1024; // 1 GB

export const ALLOWED_AUDIO_MIMES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/webm',
  'audio/aac',
]);

/**
 * `agentSlug` shape: the Agent lineage slug (`WORKFLOW_DEFINITION_SLUG_PATTERN`
 * family — lowercase alphanumerics + dashes, leading alphanumeric). An agent is
 * addressed by slug, never by id, on the business plane. Rejects arbitrary
 * strings, paths, SQL fragments and the bare hyphen `-`.
 */
export const AGENT_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * TASK-951 R2 (D-8) — ceiling on `CreateStreamSessionRequest.context`, measured as the UTF-8
 * byte length of its canonical JSON.
 *
 * The object is stored in Redis for the session's lifetime and attached to EVERY transcript of
 * that session, so its cost is paid per utterance, not once. 4 KB is generous for the identifying
 * metadata this field exists to carry (a mic id, a speaker label, a channel) and small enough that
 * a client cannot smuggle a payload down the caption stream. Over it is a 413, never a silent
 * truncation — a truncated echo is worse than a refused one, because the client would believe the
 * labels it reads back.
 */
export const MAX_STREAM_SESSION_CONTEXT_BYTES = 4096;

export class TranscribeFileRequest {
  /**
   * TASK-861 — the ASR Agent to transcribe with (lineage slug of a PUBLISHED
   * `SPEECH_TO_TEXT` agent visible to the tenant). Omit it to use the tenant's
   * assigned agent (department → tenant → SYSTEM cascade). A foreign or unknown
   * slug is a 404 (404-over-403).
   */
  @ApiPropertyOptional({ description: 'ASR Agent slug. Omit to use the assigned agent (department → tenant → platform default).' })
  @IsString()
  @IsOptional()
  @Matches(AGENT_SLUG_PATTERN, { message: 'agentSlug must be a slug ([A-Za-z0-9-])' })
  agentSlug?: string;

  @ApiPropertyOptional({ description: 'Associated consultation ID' })
  @IsUUID()
  @IsOptional()
  consultationId?: string;

  @ApiPropertyOptional({
    description:
      'Spoken language as a BCP-47 tag (`en-US`, `ml-IN`) or a mode id — normalized to one spoken-language mode. `languageMode` wins when both are sent. ' +
      '400 `LANGUAGE_MODE_UNKNOWN` when it names no mode.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  language?: string;

  /**
   * TASK-1004 — the spoken-language MODE for this recording. Omit it (and `language`) to inherit
   * the consultation's declared mode (`consultationId`), else the ASR agent's own default. It
   * configures decoding only; the engine is the agent's.
   */
  @ApiPropertyOptional({
    description:
      "Spoken-language mode id: 'en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto'. Takes precedence over `language`. Omit both to inherit the consultation's declared mode, " +
      'else the ASR agent’s own default. Never chooses the engine. 400 `LANGUAGE_MODE_UNKNOWN` when it names no mode. The job reports what was applied as `languageResolution`.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  languageMode?: string;

  /**
   * The clinician this recording belongs to.
   *
   * REQUIRED for a SERVICE ACCOUNT: a machine identity binds to a working TENANT rather than to a
   * person, so it has no clinician of its own and the platform will not invent one. An API KEY may
   * name only the human it is bound to unless that human administers this tenant; a human caller
   * omits it (they ARE the clinician) unless they administer the tenant. Full rule: the AUTH-NOTE
   * on `POST audio/transcription-jobs/transcribe`.
   *
   * Spelled exactly as `POST dna-writing-styles/ingest` and `POST consultations` spell it, so the
   * platform has ONE name for "the clinician a machine is acting for" rather than three.
   *
   * `@IsString` + `@MinLength(1)`, never `@IsUUID()`: the seeded clinician ids (`70000000-…`) are
   * deterministic and NOT version-compliant UUIDs, so a UUID validator rejects real users.
   */
  @ApiPropertyOptional({
    description:
      'The clinician this transcription belongs to. REQUIRED for a service-account caller — a machine is never itself the ' +
      'clinician. An API key may name only the human it is bound to (a tenant or super administrator may name any clinician ' +
      'of their tenant); a human omits it to transcribe as themselves.',
    format: 'uuid',
  })
  @IsString()
  @IsOptional()
  @MinLength(1)
  clinicianUserId?: string;
}

export class CreateStreamSessionRequest {
  /**
   * TASK-861 — the ASR Agent to stream with (lineage slug of a PUBLISHED
   * `SPEECH_TO_TEXT` agent visible to the tenant). Omit it to use the tenant's
   * assigned agent (department → tenant → SYSTEM cascade).
   */
  @ApiPropertyOptional({ description: 'ASR Agent slug. Omit to use the assigned agent (department → tenant → platform default).' })
  @IsString()
  @IsOptional()
  @Matches(AGENT_SLUG_PATTERN, { message: 'agentSlug must be a slug ([A-Za-z0-9-])' })
  agentSlug?: string;

  @ApiPropertyOptional({ description: 'Associated consultation ID' })
  @IsString()
  @IsOptional()
  consultationId?: string;

  /**
   * TASK-1042 (C1) — the published workflow whose STANDALONE run this session will feed
   * (`input.<audio>.sttSessionId` on `POST /workflows/{slug}/runs`). Mutually exclusive with
   * `consultationId`. Without an `agentSlug`, the ASR agent resolves from that workflow's single
   * speech-to-text step (`agentSource: 'workflow'`), so the run's agent-agreement check passes.
   */
  @ApiPropertyOptional({
    description:
      'Slug of the published workflow whose standalone run this session will feed. Without agentSlug, the speech-to-text agent ' +
      "resolves from that workflow's speech-to-text step (agentSource 'workflow'). Mutually exclusive with consultationId " +
      '(400 STREAM_SESSION_TARGET_CONFLICT).',
  })
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(128)
  workflowSlug?: string;

  @ApiPropertyOptional({ description: 'Audio sample rate in Hz', default: 16000 })
  @IsNumber()
  @IsOptional()
  sampleRate?: number;

  @ApiPropertyOptional({
    description:
      'Spoken language as a BCP-47 tag (`en-US`, `ml-IN`) or a mode id — normalized to one spoken-language mode. `languageMode` wins when both are sent. ' +
      '400 `LANGUAGE_MODE_UNKNOWN` when it names no mode.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  language?: string;

  @ApiPropertyOptional({
    description:
      "Spoken-language mode id: 'en', 'ml', 'ml-en' (Malayalam+English code-switch), 'vi', 'vi-en', 'auto'. Takes precedence over `language`. " +
      "Omit both to inherit the consultation's declared mode (`consultationId`), else the ASR agent's own default. " +
      'It configures decoding only — it never chooses the engine. 400 `LANGUAGE_MODE_UNKNOWN` when it names no mode; ' +
      '422 when no engine in the agent’s chain can serve it. What was applied is echoed as `languageResolution`.',
  })
  @IsString()
  @IsOptional()
  @MaxLength(64)
  languageMode?: string;

  @ApiPropertyOptional({
    description:
      "Pre-start default-provider selection (C7). 'fallback' opens the session directly on the ASR agent's fallback engine; " +
      "'primary' (default) opens on its primary engine. Fail-closed: 'fallback' when the agent declares no fallback engine → 409.",
    enum: ['primary', 'fallback'],
  })
  @IsIn(['primary', 'fallback'])
  @IsOptional()
  startOn?: 'primary' | 'fallback';

  @ApiPropertyOptional({
    description:
      'Number of distinct microphone SOURCES mixed into the session (#12): 1 for a single mic, 2+ for dual-/multi-mic. ' +
      'A usage-repricing metadata signal (bills 1×, OQ2), NOT a PCM channel count — the uplink is always mono. Forwarded to STT and echoed on teardown. Default 1.',
    minimum: 1,
    maximum: 8,
    default: 1,
  })
  @IsInt()
  @Min(1)
  @Max(8)
  @IsOptional()
  channelCount?: number;

  /**
   * TASK-951 R2 (D-8) — client-owned metadata for THIS session, echoed verbatim on every
   * transcript it produces.
   *
   * Shape is the context-schema envelope `{ [kindKey]: payload }`, the same shape
   * `POST consultations/open` takes, so a tenant declares the vocabulary ONCE on a context schema
   * and both planes speak it. When the session's resolved ASR agent BINDS a context schema, the
   * object is validated against that agent's FROZEN `compiledConfig.contextSchema.payloadSchema`
   * (400 `CONTEXT_SCHEMA_VIOLATION`); when it binds none, any object within the size bound is
   * accepted — an agent that declares no vocabulary has nothing to refuse.
   *
   * HOPE never interprets it and never forwards it to `apps/stt`. It is how a caller that opens
   * one session per microphone gets per-mic attribution back without HOPE's mixer, diarization or
   * consultation binding knowing anything about microphones.
   */
  @ApiPropertyOptional({
    description:
      'Client-owned session metadata, echoed verbatim on every transcript of this session. ' +
      'Context-schema envelope `{ [kindKey]: payload }`; validated against the resolved ASR agent’s bound schema when it has one. ' +
      'Max 4096 bytes of canonical JSON (413 above it).',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  @IsOptional()
  context?: Record<string, unknown>;
}

/**
 * TASK-1048 — one optional speech-to-text stage that was switched OFF for this session/job instead
 * of refusing it (owner decision OD-1, 2026-10-06). The documented mirror of the frozen
 * `AsrSessionWarning` contract (`@arcaai/types`, re-exported by `@arcaai/applications`). Carries
 * no PHI: a code, the agent identity, and a fixed sentence.
 */
export class AsrSessionWarningResponse implements AsrSessionWarning {
  @ApiProperty({
    description:
      'What was switched off: DIARIZATION_MODEL_MISSING (diarization enabled, no speaker-embedding model resolves), ' +
      'DIARIZATION_BACKEND_UNSUPPORTED (a retired diarization backend), VAD_MODEL_MISSING (VAD enabled with no VAD model — ' +
      'audio is segmented on energy), FALLBACK_UNRUNNABLE (a configured fallback could not be built and was skipped).',
    enum: ASR_DEGRADATION_CODES,
  })
  code!: AsrDegradationCode;

  @ApiProperty({ description: 'The optional stage the warning concerns.', enum: ['diarization', 'vad', 'fallback'] })
  stage!: AsrDegradedStage;

  @ApiProperty({ description: "Always 'WARNING' — a refusal is an HTTP error, never an entry here.", enum: ['WARNING'] })
  severity!: 'WARNING';

  @ApiProperty({ description: 'A fixed, PHI-free sentence a UI may show verbatim.' })
  message!: string;

  @ApiProperty({ description: 'The agent whose configuration caused it — the primary, or the fallback that was skipped.' })
  agentSlug!: string;

  @ApiPropertyOptional({ description: 'Version number of that agent, when known.' })
  agentVersionNumber?: number;
}

export class StreamSessionResponse {
  @ApiProperty({ description: 'Session ID' })
  sessionId!: string;

  @ApiProperty({ description: 'Session status' })
  status!: string;

  @ApiProperty({ description: 'WebSocket URL for streaming' })
  wsUrl!: string;

  @ApiProperty({ description: 'Maximum concurrent sessions allowed' })
  maxConcurrent!: number;

  @ApiProperty({ description: 'Currently active sessions' })
  currentActive!: number;

  /** TASK-861 — the agent the session resolved to. */
  @ApiPropertyOptional({ description: 'ASR Agent slug the session resolved to' })
  @IsOptional()
  @IsString()
  agentSlug?: string;

  @ApiPropertyOptional({ description: 'ASR Agent VERSION id the session runs on' })
  @IsOptional()
  @IsString()
  agentVersionId?: string;

  /**
   * TASK-1002 — which rule chose the session's speech-to-text agent: an explicit `agentSlug`
   * on the request (`'explicit'`), the consultation's governing workflow's SPEECH_TO_TEXT node
   * (`'workflow'`), or the `AgentAssignment` cascade — a department-level assignment
   * (`'department'`) or the tenant's untagged default (`'tenant'`).
   */
  @ApiPropertyOptional({
    description:
      "Which rule chose the session's speech-to-text agent: an explicit agentSlug on the request, the consultation's " +
      'governing workflow speech-to-text node, or the department then tenant assignment.',
    enum: ['explicit', 'workflow', 'department', 'tenant'],
  })
  @IsOptional()
  @IsString()
  agentSource?: 'explicit' | 'workflow' | 'department' | 'tenant';

  /**
   * The engine actually live at create: `'primary'`, or `'fallback'` when the
   * session opened on the tenant fallback — by choice (`startOn`) or because
   * the primary ASR failed to load.
   */
  @ApiPropertyOptional({ description: "Engine live at create: 'primary' or 'fallback'", enum: ['primary', 'fallback'] })
  @IsOptional()
  @IsString()
  activeEngine?: 'primary' | 'fallback';

  /**
   * One-shot stream ticket the SDK appends to the WebSocket URL.
   * The gateway consumes the ticket on first WS open; subsequent connects must
   * mint a fresh ticket via `POST /stream/session/:id/refresh-ticket`.
   */
  @ApiProperty({ description: 'Single-use stream ticket for WS handshake' })
  @IsString()
  ticket!: string;

  @ApiProperty({ description: 'Epoch milliseconds when the ticket expires' })
  @IsNumber()
  ticketExpiresAt!: number;

  /**
   * True when the speaker voice profile was preseeded into
   * STT during session creation. Surfaced so the SDK can short-circuit a
   * follow-up `voice-enrollment-status` request.
   */
  @ApiPropertyOptional({ description: 'Whether the speaker voice profile was preseeded' })
  @IsBoolean()
  @IsOptional()
  voiceProfileSeeded?: boolean;

  /**
   * TASK-951 R2 — the accepted `context`, echoed back so a client can confirm what HOPE stored
   * (and therefore what it will see on every transcript) without waiting for the first utterance.
   * Absent when the request declared none.
   */
  @ApiPropertyOptional({
    description: 'The client-declared session context, as stored. Absent when none was sent.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  @IsOptional()
  context?: Record<string, unknown>;

  /**
   * TASK-951 R2 — epoch milliseconds at session creation, the clock every segment time of this
   * session is relative to. Always populated by this gateway; typed optional so a client built
   * against an older gateway keeps compiling.
   */
  @ApiPropertyOptional({ description: 'Epoch ms at session creation; segment times are relative to it' })
  @IsNumber()
  @IsOptional()
  sessionEpochMs?: number;

  /**
   * TASK-1004 — the language RECEIPT: the mode the precedence resolved (request > consultation >
   * agent > auto), who declared it, and what the serving engine actually applied (`degraded` +
   * `reason` when only partially). Also on the WS `ready` frame and on every `provider_switched`.
   */
  @ApiPropertyOptional({
    type: LanguageResolutionResponse,
    description: 'What the session was asked for and what its serving engine applied. Absent against an STT that predates the receipt.',
  })
  @IsObject()
  @IsOptional()
  languageResolution?: LanguageResolutionResponse;

  /**
   * TASK-1048 — optional stages switched off for this session instead of refusing it (diarization
   * with no speaker-embedding model, VAD with no VAD model, a skipped fallback). Absent when none.
   */
  @ApiPropertyOptional({
    type: AsrSessionWarningResponse,
    isArray: true,
    description:
      'Optional speech-to-text stages switched OFF for this session instead of refusing it (the core transcription still ' +
      'runs). Absent when there are none.',
  })
  warnings?: AsrSessionWarningResponse[];
}

export class BatchTranscribeResponse {
  @ApiProperty({ description: 'Transcription job ID' })
  id!: string;

  @ApiProperty({ description: 'Current job status' })
  status!: string;

  @ApiProperty({ description: 'SSE stream URL for real-time updates' })
  sseUrl!: string;

  @ApiProperty({ description: 'Audio file URI in storage' })
  audioUri!: string;

  /** TASK-861 — the agent the job resolved to. */
  @ApiPropertyOptional({ description: 'ASR Agent slug the job resolved to' })
  agentSlug?: string;

  @ApiPropertyOptional({ description: 'ASR Agent VERSION id the job runs on' })
  agentVersionId?: string;

  /** TASK-1048 — optional stages switched off for this job instead of refusing it. Absent when none. */
  @ApiPropertyOptional({
    type: AsrSessionWarningResponse,
    isArray: true,
    description: 'Optional speech-to-text stages switched OFF for this job instead of refusing it. Absent when there are none.',
  })
  warnings?: AsrSessionWarningResponse[];
}

/**
 * The batch ceilings a client must respect, resolved from the
 * admin-configurable `stt.batch.*` settings. Served by
 * `GET /audio/transcription-jobs/limits` so the SDK enforces the SAME numbers
 * the gateway does rather than hardcoding them a second time.
 */
export class BatchTranscriptionLimitsResponse {
  @ApiProperty({ description: 'Recordings a client may submit as one batch' })
  maxFilesPerBatch!: number;

  @ApiProperty({ description: 'Duration ceiling for one recording, in minutes' })
  maxDurationMinutes!: number;

  @ApiProperty({ description: 'Size ceiling for one recording, in bytes' })
  maxFileSizeBytes!: number;

  @ApiProperty({ description: 'Queued or processing jobs one caller may hold at once' })
  maxActiveJobsPerUser!: number;

  @ApiProperty({ description: 'Accepted audio MIME types', type: [String] })
  allowedMimeTypes!: string[];
}
