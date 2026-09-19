import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches, Max, Min, MinLength } from 'class-validator';

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

/**
 * `pipelineId` shape validation.
 *
 * Accepts either:
 *   • Slug (lowercase alphanumeric + dashes, must start alphanumeric): `general-consult`, `cardio2`
 *   • UUID v4 (case-insensitive): `f47ac10b-58cc-4372-a567-0e02b2c3d479`
 *
 * Rejects arbitrary strings, paths, SQL fragments, and the bare hyphen
 * `-` (regex requires a leading [A-Za-z0-9]).
 */
export const PIPELINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
 * family — lowercase alphanumerics + dashes). Same shape guard as `pipelineId`,
 * minus the UUID branch (an agent is addressed by slug, never by id, on the
 * business plane).
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

  /**
   * @deprecated TASK-861 — removed in R4. The `AsrPipeline` to run on; answers
   * with `Deprecation` headers. Prefer `agentSlug` (or nothing, for the
   * assigned agent).
   */
  @ApiPropertyOptional({ description: 'DEPRECATED (TASK-861, removed in R4): Pipeline ID (slug or UUID). Prefer `agentSlug`.', deprecated: true })
  @IsString()
  @IsOptional()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (D-19)',
  })
  pipelineId?: string;

  @ApiPropertyOptional({ description: 'Associated consultation ID' })
  @IsUUID()
  @IsOptional()
  consultationId?: string;

  @ApiPropertyOptional({ description: 'Override pipeline language (ISO 639-1 code, e.g. en, vi, auto)' })
  @IsString()
  @IsOptional()
  language?: string;

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
   * `SPEECH_TO_TEXT` agent visible to the tenant). Omit it — and `pipelineId` —
   * to use the tenant's assigned agent (department → tenant → SYSTEM cascade).
   */
  @ApiPropertyOptional({ description: 'ASR Agent slug. Omit to use the assigned agent (department → tenant → platform default).' })
  @IsString()
  @IsOptional()
  @Matches(AGENT_SLUG_PATTERN, { message: 'agentSlug must be a slug ([A-Za-z0-9-])' })
  agentSlug?: string;

  /**
   * @deprecated TASK-861 — removed in R4. The `AsrPipeline` to stream on;
   * answers with `Deprecation` headers. Prefer `agentSlug`.
   */
  @ApiPropertyOptional({ description: 'DEPRECATED (TASK-861, removed in R4): Pipeline ID (slug or UUID). Prefer `agentSlug`.', deprecated: true })
  @IsString()
  @IsOptional()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (D-19)',
  })
  pipelineId?: string;

  @ApiPropertyOptional({ description: 'Associated consultation ID' })
  @IsString()
  @IsOptional()
  consultationId?: string;

  @ApiPropertyOptional({ description: 'Audio sample rate in Hz', default: 16000 })
  @IsNumber()
  @IsOptional()
  sampleRate?: number;

  @ApiPropertyOptional({ description: 'Override pipeline language (ISO 639-1 code, e.g. en, vi, auto)' })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description:
      "End-user language mode id , e.g. 'en', 'ml', 'ml-en' (Malayalam+English code-switch), 'auto'. " +
      'Resolved by STT against the session engine; a mode no configured engine can serve is rejected (422). Takes precedence over `language`.',
  })
  @IsString()
  @IsOptional()
  languageMode?: string;

  @ApiPropertyOptional({
    description:
      "Pre-start default-provider selection (C7). 'fallback' opens the session directly on the tenant-admin default (fallback) engine; " +
      "'primary' (default) opens on the configured pipeline. Fail-closed: 'fallback' with no configured fallback pipeline → 409.",
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

  /**
   * The RESOLVED ASR pipeline the session opened with. Differs from
   * the requested id whenever the caller sent none. The SDK uses this as its
   * `activePipeline` baseline instead of echoing back its own request — which
   * left it null for every session started without an explicit pipeline.
   * Absent against an STT that predates the echo.
   */
  @ApiPropertyOptional({
    description: 'The runtime key the session opened with: the ASR Agent VERSION id (agent path) or the resolved AsrPipeline id (deprecated path)',
  })
  @IsOptional()
  @IsString()
  pipelineId?: string;

  /** TASK-861 — the agent the session resolved to (absent on the deprecated pipeline path). */
  @ApiPropertyOptional({ description: 'ASR Agent slug the session resolved to' })
  @IsOptional()
  @IsString()
  agentSlug?: string;

  @ApiPropertyOptional({ description: 'ASR Agent VERSION id the session runs on' })
  @IsOptional()
  @IsString()
  agentVersionId?: string;

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

  /** TASK-861 — the agent the job resolved to (absent on the deprecated pipeline path). */
  @ApiPropertyOptional({ description: 'ASR Agent slug the job resolved to' })
  agentSlug?: string;

  @ApiPropertyOptional({ description: 'ASR Agent VERSION id the job runs on' })
  agentVersionId?: string;
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

/**
 * The tenant's configured STT fallback pipeline, for the live
 * pipeline↔default toggle. Identity only — never credential material.
 * `configured: false` means the toggle should be disabled rather than offered
 * and failed with a 409 mid-consultation.
 */
export class SttFallbackProviderResponse {
  @ApiProperty({ description: 'Whether the resolved ASR agent declares a usable fallback engine' })
  configured!: boolean;

  @ApiProperty({
    description: 'The fallback engine’s runtime key (TASK-861: `ResolvedAsrSpec.fallback.spec.runtimeKey`; formerly the fallback pipeline id)',
    nullable: true,
  })
  pipelineId!: string | null;

  @ApiProperty({ description: 'Display name of the fallback engine (fallback agent slug, or the fallback model slug)', nullable: true })
  pipelineName!: string | null;

  @ApiPropertyOptional({ description: 'TASK-861 — the primary ASR agent the fallback belongs to' })
  agentSlug?: string;
}
