import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsNumber, IsBoolean, IsUUID, Matches, Min, Max } from 'class-validator';
import { TranscriptionJobType } from '@arcaai/domains';

/**
 * Pipeline-id contract: a `pipelineId` is a slug
 * (`general-consult`) OR a UUID-shaped id. The platform's seeded pipelines use
 * deterministic, non-RFC-versioned UUIDs (e.g. `81000000-0000-0000-0001-000000000001`),
 * which a strict `@IsUUID(7)` rejects. Mirror the HTTP-boundary DTOs
 * (apps/api transcription-job.dto.ts) which validate against this same pattern.
 */
export const PIPELINE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class CreateJobRequest {
  @ApiProperty({
    description: 'Job type',
    enum: TranscriptionJobType,
    example: TranscriptionJobType.BATCH,
  })
  @IsEnum(TranscriptionJobType)
  jobType: TranscriptionJobType;

  @ApiProperty({
    description: 'Pipeline ID (slug or UUID) to use for transcription',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (TASK-298 D-19)',
  })
  pipelineId: string;

  @ApiPropertyOptional({
    description: 'Consultation ID to associate the transcription with',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID(7)
  consultationId?: string;

  @ApiPropertyOptional({
    description: 'Media ID for batch transcription (required for BATCH job type)',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID(7)
  mediaId?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of retries on failure',
    example: 3,
    default: 3,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @ApiPropertyOptional({
    description: 'Language hint (ISO 639-1 code, e.g. "en", "ml"). Overrides the pipeline default.',
    example: 'en',
  })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description:
      'Enable multilingual code-switching. When true, the model will attempt to detect and transcribe multiple languages within the same audio. Overrides the pipeline default.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}

export class CreateBatchJobRequest {
  @ApiProperty({
    description: 'Pipeline ID to use for transcription',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID(7)
  pipelineId: string;

  @ApiProperty({
    description: 'Media ID for batch transcription',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID(7)
  mediaId: string;

  @ApiPropertyOptional({
    description: 'Consultation ID to associate the transcription with',
  })
  @IsString()
  @IsOptional()
  @IsUUID(7)
  consultationId?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of retries on failure',
    default: 3,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @ApiPropertyOptional({
    description: 'Language hint (ISO 639-1 code, e.g. "en", "ml"). Overrides the pipeline default.',
    example: 'en',
  })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description: 'Enable multilingual code-switching. Overrides the pipeline default.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}

export class CreateStreamingJobRequest {
  @ApiProperty({
    description: 'Pipeline ID to use for transcription',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID(7)
  pipelineId: string;

  @ApiPropertyOptional({
    description: 'Consultation ID to associate the transcription with',
  })
  @IsString()
  @IsOptional()
  @IsUUID(7)
  consultationId?: string;

  @ApiPropertyOptional({
    description: 'Maximum number of retries on failure',
    default: 3,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @ApiPropertyOptional({
    description: 'Language hint (ISO 639-1 code, e.g. "en", "ml"). Overrides the pipeline default.',
    example: 'en',
  })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description: 'Enable multilingual code-switching. Overrides the pipeline default.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}
