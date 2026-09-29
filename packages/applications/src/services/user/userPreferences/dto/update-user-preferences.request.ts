import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsNumber, IsBoolean, Min, Max, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { BaseRequest } from '../../../../common';

export class NoiseCancellationConfigDto {
  /**
   * @deprecated TASK-1012 L-6 — a client-side model pick for a browser AI stage SDK 4.0.0 removed.
   * Still declared because the published SDK round-trips it; ignored and never persisted.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored — a client-side noise-cancellation model id. The browser runs no model since SDK 4.0.0; a server-side Agent selects the model. Never persisted.',
  })
  @IsOptional()
  @IsString()
  modelId?: string;

  @ApiPropertyOptional({
    description: 'Noise cancellation intensity level',
    enum: ['low', 'medium', 'high'],
  })
  @IsOptional()
  @IsEnum(['low', 'medium', 'high'])
  level?: 'low' | 'medium' | 'high';
}

export class STTConfigDto {
  /**
   * @deprecated TASK-1012 L-6 — a client-side model pick for a browser AI stage SDK 4.0.0 removed.
   * Still declared because the published SDK round-trips it; ignored and never persisted.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored — a client-side speech-to-text model id. The browser runs no model since SDK 4.0.0; a server-side Agent selects the model. Never persisted.',
  })
  @IsOptional()
  @IsString()
  modelId?: string;
}

export class VADConfigDto {
  /**
   * @deprecated TASK-1012 L-6 — a client-side model pick for a browser AI stage SDK 4.0.0 removed.
   * Still declared because the published SDK round-trips it; ignored and never persisted.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored — a client-side voice-activity-detection model id. The browser runs no model since SDK 4.0.0; a server-side Agent selects the model. Never persisted.',
  })
  @IsOptional()
  @IsString()
  modelId?: string;

  @ApiPropertyOptional({ description: 'Speech detection sensitivity (0-1)', minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  sensitivity?: number;
}

export class NERConfigDto {
  /**
   * @deprecated TASK-1012 L-6 — a client-side model pick for a browser AI stage SDK 4.0.0 removed.
   * Still declared because the published SDK round-trips it; ignored and never persisted.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored — a client-side NER model id. The browser runs no model since SDK 4.0.0; a server-side Agent selects the model. Never persisted.',
  })
  @IsOptional()
  @IsString()
  modelId?: string;

  @ApiPropertyOptional({ description: 'Automatically extract entities from transcriptions' })
  @IsOptional()
  @IsBoolean()
  autoExtract?: boolean;
}

export class DiarizationConfigDto {
  @ApiPropertyOptional({ description: 'Enable speaker diarization via voice embedding' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Automatically register new speakers' })
  @IsOptional()
  @IsBoolean()
  autoEnroll?: boolean;
}

/**
 * Voice profile preferences for the local workflow.
 *
 * The activated voice profile itself lives in `UserVoiceProfile` (single source of truth
 * for `isActive`). This DTO captures behavioural preferences AROUND voice profiles --
 * things the doctor can toggle from the SDK without re-enrolling.
 */
export class VoiceProfileConfigDto {
  @ApiPropertyOptional({
    description: 'When a new enrollment succeeds and no profile is currently active, auto-activate it.',
  })
  @IsOptional()
  @IsBoolean()
  autoActivateLatest?: boolean;

  @ApiPropertyOptional({
    description: 'Local diarizer cosine-similarity threshold for matching a known speaker (0-1)',
    minimum: 0,
    maximum: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  similarityThreshold?: number;

  @ApiPropertyOptional({
    description: "Whether to anchor the local diarizer to the user's active voice profile (when one exists).",
  })
  @IsOptional()
  @IsBoolean()
  useBackendAnchor?: boolean;
}

export class LocalWorkflowConfigDto {
  @ApiPropertyOptional({ description: 'Noise cancellation configuration', type: NoiseCancellationConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NoiseCancellationConfigDto)
  noiseCancellation?: NoiseCancellationConfigDto;

  @ApiPropertyOptional({ description: 'Speech-to-text configuration', type: STTConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => STTConfigDto)
  stt?: STTConfigDto;

  @ApiPropertyOptional({ description: 'Voice Activity Detection configuration', type: VADConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => VADConfigDto)
  vad?: VADConfigDto;

  @ApiPropertyOptional({ description: 'Named Entity Recognition configuration', type: NERConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NERConfigDto)
  ner?: NERConfigDto;

  @ApiPropertyOptional({ description: 'Speaker diarization configuration', type: DiarizationConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DiarizationConfigDto)
  diarization?: DiarizationConfigDto;

  @ApiPropertyOptional({
    description: 'Voice profile preferences (active profile lives in UserVoiceProfile)',
    type: VoiceProfileConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => VoiceProfileConfigDto)
  voiceProfile?: VoiceProfileConfigDto;
}

/**
 * Update user preferences request DTO.
 * Supports partial updates - only provided fields are updated.
 *
 * NOTE: remoteConfig is NOT included -- pipeline assignment is admin-controlled.
 * NOTE: codeSwitching is NOT included -- it's a pipeline-level config in YAML.
 */
export class UpdateUserPreferencesRequest extends BaseRequest {
  @ApiPropertyOptional({
    description: 'Workflow mode: local (doctor selects models) or remote (admin-configured pipeline)',
    enum: ['local', 'remote'],
  })
  @IsOptional()
  @IsEnum(['local', 'remote'])
  workflowMode?: 'local' | 'remote';

  @ApiPropertyOptional({ description: 'Preferred language code (e.g. "en", "th")' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ description: 'DNA writing style ID for summarization' })
  @IsOptional()
  @IsString()
  dnaStyleId?: string;

  @ApiPropertyOptional({
    description: 'Local workflow model configuration (used when workflowMode is "local")',
    type: LocalWorkflowConfigDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocalWorkflowConfigDto)
  localConfig?: LocalWorkflowConfigDto;

  @ApiPropertyOptional({
    description: 'Custom preferences (extensible)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  custom?: Record<string, unknown>;
}
