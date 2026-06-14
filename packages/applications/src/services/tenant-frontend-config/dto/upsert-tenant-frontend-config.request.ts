import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { CaptureMode, TranscriptionMode } from '@arcaai/domains';
import { FrontendPipelineConfigJson } from './frontend-pipeline-config';

/**
 * Create-or-update the tenant's frontend audio-pipeline defaults (TASK-328 A6).
 *
 * Every field is optional: on first save the tenant config is created from the
 * provided fields (missing booleans default to `false`); on subsequent saves
 * only the supplied fields are changed. `expectedVersion` carries the OCC token
 * and is REQUIRED for updates (the controller folds the `If-Match` header into
 * it); it is ignored on the initial create.
 */
export class UpsertTenantFrontendConfigRequest {
  @ApiPropertyOptional({ description: 'Default ASR model slug/id for the tenant' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  asrModel?: string | null;

  @ApiPropertyOptional({ description: 'Enable browser noise cancellation by default' })
  @IsOptional()
  @IsBoolean()
  noiseCancel?: boolean;

  @ApiPropertyOptional({ description: 'Enable voice-activity detection by default' })
  @IsOptional()
  @IsBoolean()
  vad?: boolean;

  @ApiPropertyOptional({ description: 'Enable voice enrollment by default' })
  @IsOptional()
  @IsBoolean()
  voiceEnrollment?: boolean;

  @ApiPropertyOptional({ description: 'Enable speaker diarization by default' })
  @IsOptional()
  @IsBoolean()
  diarization?: boolean;

  // TASK-332 — tenant toggle for local raw-stream dual-capture. Honored only
  // when the platform capability (`enable-local-raw-capture` GlobalSetting) is
  // ON; the SDK-facing enablement is the server-computed AND of the two.
  @ApiPropertyOptional({ description: 'Enable local raw-stream audio capture for the tenant (effective only when the platform capability is on)' })
  @IsOptional()
  @IsBoolean()
  captureRawAudio?: boolean;

  // TASK-356 Phase 4 (G-7 / D-8) — tenant default transcription mode + lock.
  // The effective mode is resolved server-side in UserPreferencesService; a
  // locked tenant wins over the doctor's workflowMode.
  @ApiPropertyOptional({ description: 'Tenant default transcription mode (LOCAL or BACKEND)', enum: TranscriptionMode })
  @IsOptional()
  @IsEnum(TranscriptionMode)
  transcriptionMode?: TranscriptionMode;

  @ApiPropertyOptional({ description: 'Lock the transcription mode so doctors cannot override it via their workflowMode' })
  @IsOptional()
  @IsBoolean()
  transcriptionModeLocked?: boolean;

  // TASK-356 Phase 4 (G-9) — tenant-scoped capture mode. Translated onto the
  // backend dual_capture booleans + the local captureRawAudio flag. `null`
  // clears the override (legacy captureRawAudio column wins again, R-6).
  @ApiPropertyOptional({ description: 'Tenant audio capture mode', enum: CaptureMode, nullable: true })
  @IsOptional()
  @IsEnum(CaptureMode)
  captureMode?: CaptureMode | null;

  @ApiPropertyOptional({ description: 'Typed advanced configuration (see FrontendPipelineConfigJson)' })
  @IsOptional()
  @IsObject()
  configJson?: FrontendPipelineConfigJson | null;

  @ApiPropertyOptional({
    description: 'Current row version (from the prior GET). REQUIRED on update; the PUT fails with 412 if the version drifted.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
