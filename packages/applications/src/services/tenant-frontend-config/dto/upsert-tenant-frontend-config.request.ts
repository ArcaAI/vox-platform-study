import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsObject, IsOptional, Min } from 'class-validator';
import { CaptureMode, TranscriptionMode } from '@arcaai/domains';
import { FrontendPipelineConfigJson } from './frontend-pipeline-config';

/**
 * Create-or-update the tenant's frontend CAPTURE policy.
 *
 * The global `ValidationPipe` runs `forbidNonWhitelisted`, so a stale caller
 * still sending a retired client-AI toggle (`noiseCancel`, `vad`, …) gets a
 * 400 naming the field rather than a silent no-op.
 *
 * Every field is optional: on first save the tenant config is created from the
 * provided fields (missing booleans default to `false`); on subsequent saves
 * only the supplied fields are changed. `expectedVersion` carries the OCC token
 * and is REQUIRED for updates (the controller folds the `If-Match` header into
 * it); it is ignored on the initial create.
 */
export class UpsertTenantFrontendConfigRequest {
  // Tenant toggle for local raw-stream dual-capture. Honored only
  // when the platform capability (`enable-local-raw-capture` GlobalSetting) is
  // ON; the SDK-facing enablement is the server-computed AND of the two.
  @ApiPropertyOptional({ description: 'Enable local raw-stream audio capture for the tenant (effective only when the platform capability is on)' })
  @IsOptional()
  @IsBoolean()
  captureRawAudio?: boolean;

  // Tenant default transcription mode + lock.
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

  // Tenant-scoped capture mode. Translated onto the
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
