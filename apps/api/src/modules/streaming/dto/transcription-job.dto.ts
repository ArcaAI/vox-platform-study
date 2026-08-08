import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

export const AUDIO_BUCKET = 'hope-audio';

/**
 * STATIC hard ceiling for the multipart interceptor (TASK-604).
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

export class TranscribeFileRequest {
  /**
   * OPTIONAL since TASK-614: omit it to transcribe on the tenant's default
   * pipeline, the same "I don't care which, use ours" intent a live session has
   * always been able to express. The gateway resolves the tenant default and
   * 409s when the tenant has neither a default nor a fallback — it never guesses
   * a pipeline.
   */
  @ApiPropertyOptional({ description: "Pipeline ID (slug or UUID). Omit to use the tenant's default pipeline." })
  @IsString()
  @IsOptional()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (TASK-298 D-19)',
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
}

export class CreateStreamSessionRequest {
  @ApiProperty({ description: 'Pipeline ID (slug or UUID) to use for streaming' })
  @IsString()
  @IsNotEmpty()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (TASK-298 D-19)',
  })
  pipelineId!: string;

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
      "End-user language mode id (TASK-587), e.g. 'en', 'ml', 'ml-en' (Malayalam+English code-switch), 'auto'. " +
      'Resolved by STT against the session engine; a mode no configured engine can serve is rejected (422). Takes precedence over `language`.',
  })
  @IsString()
  @IsOptional()
  languageMode?: string;

  @ApiPropertyOptional({
    description:
      "Pre-start default-provider selection (TASK-586 C7). 'fallback' opens the session directly on the tenant-admin default (fallback) engine; " +
      "'primary' (default) opens on the configured pipeline. Fail-closed: 'fallback' with no configured fallback pipeline → 409.",
    enum: ['primary', 'fallback'],
  })
  @IsIn(['primary', 'fallback'])
  @IsOptional()
  startOn?: 'primary' | 'fallback';

  @ApiPropertyOptional({
    description:
      'Number of distinct microphone SOURCES mixed into the session (TASK-615 #12): 1 for a single mic, 2+ for dual-/multi-mic. ' +
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
   * The RESOLVED ASR pipeline the session opened with (TASK-614). Differs from
   * the requested id whenever the caller sent none. The SDK uses this as its
   * `activePipeline` baseline instead of echoing back its own request — which
   * left it null for every session started without an explicit pipeline.
   * Absent against an STT that predates the echo.
   */
  @ApiPropertyOptional({ description: 'Resolved ASR pipeline id the session opened with' })
  @IsOptional()
  @IsString()
  pipelineId?: string;

  /**
   * The engine actually live at create: `'primary'`, or `'fallback'` when the
   * session opened on the tenant fallback — by choice (`startOn`) or because
   * the primary ASR failed to load (TASK-614).
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
}

/**
 * The batch ceilings a client must respect (TASK-604), resolved from the
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
 * The tenant's configured STT fallback pipeline (TASK-604), for the live
 * pipeline↔default toggle. Identity only — never credential material.
 * `configured: false` means the toggle should be disabled rather than offered
 * and failed with a 409 mid-consultation.
 */
export class SttFallbackProviderResponse {
  @ApiProperty({ description: 'Whether a usable fallback pipeline is configured for this tenant' })
  configured!: boolean;

  @ApiProperty({ description: 'Configured fallback pipeline id, if any', nullable: true })
  pipelineId!: string | null;

  @ApiProperty({ description: 'Display name of the fallback pipeline, if resolvable', nullable: true })
  pipelineName!: string | null;
}
