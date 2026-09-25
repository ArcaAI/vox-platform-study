import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class LocalConfigResponseDto {
  @ApiPropertyOptional({ description: 'Noise cancellation configuration' })
  noiseCancellation?: {
    modelId: string;
    level: 'low' | 'medium' | 'high';
  };

  @ApiPropertyOptional({ description: 'Speech-to-text configuration' })
  stt?: {
    modelId: string;
  };

  @ApiPropertyOptional({ description: 'Voice Activity Detection configuration' })
  vad?: {
    modelId: string;
    sensitivity: number;
  };

  @ApiPropertyOptional({ description: 'Named Entity Recognition configuration' })
  ner?: {
    modelId: string;
    autoExtract: boolean;
  };

  @ApiPropertyOptional({ description: 'Speaker diarization configuration' })
  diarization?: {
    enabled: boolean;
    autoEnroll: boolean;
  };

  @ApiPropertyOptional({
    description: 'Voice profile preferences (active profile lives in UserVoiceProfile). User-controlled.',
  })
  voiceProfile?: {
    autoActivateLatest?: boolean;
    similarityThreshold?: number;
    useBackendAnchor?: boolean;
  };
}

/**
 * Active voice profile summary, resolved from `UserVoiceProfile.isActive` at read time.
 * Read-only -- mutations go through `VoiceProfileService.activate / deactivate / enroll`.
 */
class ActiveVoiceProfileDto {
  @ApiProperty({ description: 'Voice profile ID (references UserVoiceProfile)' })
  id!: string;

  @ApiPropertyOptional({ description: 'Optional doctor-supplied label' })
  label?: string;

  @ApiPropertyOptional({ description: 'STT embedding model that produced the profile' })
  modelId?: string;

  @ApiProperty({ description: 'Profile creation timestamp (ISO-8601)' })
  createdAt!: string;
}

/**
 * User preferences response DTO.
 * Matches SDK's UserPreferences interface.
 */
export class UserPreferencesResponse {
  @ApiPropertyOptional({
    description: 'Workflow mode',
    enum: ['local', 'remote'],
  })
  workflowMode?: 'local' | 'remote';

  @ApiPropertyOptional({ description: 'Preferred language code (e.g., "en", "th")' })
  language?: string;

  @ApiPropertyOptional({ description: 'DNA writing style ID' })
  dnaStyleId?: string;

  @ApiPropertyOptional({
    description: 'Local workflow model configuration',
    type: LocalConfigResponseDto,
  })
  localConfig?: LocalConfigResponseDto;

  @ApiPropertyOptional({
    description: 'Read-only summary of the currently active voice profile (resolved from UserVoiceProfile at read time)',
    type: ActiveVoiceProfileDto,
  })
  activeVoiceProfile?: ActiveVoiceProfileDto;

  @ApiPropertyOptional({
    description: 'Custom preferences (extensible)',
    type: 'object',
    additionalProperties: true,
  })
  custom?: Record<string, unknown>;

  // Read-only EFFECTIVE transcription mode + lock, resolved
  // server-side (locked ⇒ tenant default wins; unlocked ⇒ workflowMode
  // overrides). The SDK re-projects this into `resolvedConfig.stt.transcriptionMode`.
  @ApiProperty({
    description: 'Effective transcription mode resolved server-side (read-only)',
    enum: ['LOCAL', 'BACKEND'],
  })
  transcriptionMode!: 'LOCAL' | 'BACKEND';

  @ApiProperty({ description: 'Whether the tenant has locked the transcription mode (read-only)' })
  transcriptionModeLocked!: boolean;

  @ApiProperty({ description: 'Last sync timestamp' })
  updatedAt!: string;
}
