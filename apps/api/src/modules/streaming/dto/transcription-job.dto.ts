import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

export const AUDIO_BUCKET = 'hope-audio';
export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

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
