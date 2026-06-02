import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
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
