import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsObject, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

class AudioSettingsDto {
  @ApiProperty({
    description: 'Sample rate in Hz',
    example: 44100,
  })
  @IsNumber()
  sampleRate: number;

  @ApiProperty({
    description: 'Audio format',
    example: 'pcm',
    enum: ['pcm', 'wav', 'mp3'],
  })
  @IsIn(['pcm', 'wav', 'mp3'])
  format: 'pcm' | 'wav' | 'mp3';

  @ApiProperty({
    description: 'Number of audio channels',
    example: 1,
    enum: [1, 2],
  })
  @IsIn([1, 2])
  channels: 1 | 2;

  @ApiProperty({
    description: 'Bit depth',
    example: 16,
    enum: [8, 16, 24, 32],
  })
  @IsIn([8, 16, 24, 32])
  bitDepth: 8 | 16 | 24 | 32;

  @ApiProperty({
    description: 'Chunk size for real-time processing',
    example: 1024,
  })
  @IsNumber()
  chunkSize: number;

  @ApiProperty({
    description: 'Enable noise suppression',
    example: true,
  })
  @IsBoolean()
  noiseSuppression: boolean;

  @ApiProperty({
    description: 'Enable echo cancellation',
    example: true,
  })
  @IsBoolean()
  echoCancellation: boolean;

  @ApiProperty({
    description: 'Enable automatic gain control',
    example: false,
  })
  @IsBoolean()
  autoGainControl: boolean;
}

export class StartSessionRequest {
  @ApiProperty({
    description: 'Unique session identifier',
    example: 'session_123456789',
  })
  @IsString()
  session_id: string;

  @ApiPropertyOptional({
    description: 'Language code for transcription',
    example: 'en-US',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  language?: string | null;

  @ApiProperty({
    description: 'Audio processing settings',
    type: AudioSettingsDto,
  })
  @IsObject()
  audioSettings: AudioSettingsDto;

  /**
   * TASK-861 — the ASR Agent to run this session on (lineage slug of a PUBLISHED
   * `SPEECH_TO_TEXT` agent visible to the tenant). Omit it — and `pipelineId` —
   * to use the tenant's assigned agent (department → tenant → SYSTEM cascade).
   * ADDITIVE: v1 clients that never send it are unaffected.
   */
  @ApiPropertyOptional({
    description: 'ASR Agent slug. Omit to use the assigned agent (department → tenant → platform default).',
    example: 'platform-transcription',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/, { message: 'agentSlug must be a slug ([A-Za-z0-9-])' })
  agentSlug?: string;

  /**
   * @deprecated TASK-861 — removed in R4. Explicit STT pipeline id; when supplied
   * it is used directly (the deprecated path). Prefer `agentSlug`.
   */
  @ApiPropertyOptional({
    description: 'DEPRECATED (TASK-861, removed in R4): explicit STT pipeline id. Prefer `agentSlug`.',
    example: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    deprecated: true,
  })
  @IsOptional()
  @IsUUID()
  pipelineId?: string;

  @ApiPropertyOptional({
    description: 'STT provider',
    example: 'azure',
    default: 'azure',
    enum: ['azure', 'whisper', 'sarvam'],
  })
  @IsOptional()
  @IsIn(['azure', 'whisper', 'sarvam'])
  provider?: 'azure' | 'whisper' | 'sarvam';

  @ApiPropertyOptional({
    description:
      "Pre-start default-provider selection (C7b). 'pipeline' (≡primary, default) opens the session on the configured pipeline; " +
      "'default' (≡fallback) opens directly on the tenant-admin default provider. Fail-closed: 'default' with no configured fallback pipeline → 409.",
    enum: ['pipeline', 'default'],
  })
  @IsOptional()
  @IsIn(['pipeline', 'default'])
  startOn?: 'pipeline' | 'default';
}
