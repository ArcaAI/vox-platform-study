import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsNumber, IsBoolean, IsObject, IsUUID, Min, Max } from 'class-validator';
import { TranscriptionJobType } from '@arcaai/domains';

export class CreateJobRequest {
  @ApiProperty({
    description: 'Job type',
    enum: TranscriptionJobType,
    example: TranscriptionJobType.BATCH,
  })
  @IsEnum(TranscriptionJobType)
  jobType: TranscriptionJobType;

  @ApiPropertyOptional({
    description:
      'TASK-861 — the published ASR Agent to run the job, by slug. Absent = the tenant`s assigned ASR agent (the same cascade as `POST …/transcribe`).',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentSlug?: string;

  @ApiPropertyOptional({
    description: 'TASK-861 — the ASR Agent VERSION id that will run the job (rows are versions). Required, with `resolvedSpec`.',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentVersionId?: string;

  @ApiPropertyOptional({
    description:
      'TASK-861 — the gateway-resolved `ResolvedAsrSpec` snapshot for this job. Set by the gateway, never by a client; persisted so the job is reproducible from its own row.',
  })
  @IsObject()
  @IsOptional()
  resolvedSpec?: Record<string, unknown>;

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
    description: 'Language hint (ISO 639-1 code, e.g. "en", "ml"). Overrides the agent default.',
    example: 'en',
  })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description:
      'Enable multilingual code-switching. When true, the model will attempt to detect and transcribe multiple languages within the same audio. Overrides the agent default.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}

export class CreateBatchJobRequest {
  @ApiPropertyOptional({
    description: 'TASK-861 — the ASR Agent VERSION id that will run the job (rows are versions). Required, with `resolvedSpec`.',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentVersionId?: string;

  @ApiPropertyOptional({
    description:
      'TASK-861 — the gateway-resolved `ResolvedAsrSpec` snapshot for this job. Set by the gateway, never by a client; persisted so the job is reproducible from its own row.',
  })
  @IsObject()
  @IsOptional()
  resolvedSpec?: Record<string, unknown>;

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
    description: 'Language hint (ISO 639-1 code, e.g. "en", "ml"). Overrides the agent default.',
    example: 'en',
  })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description: 'Enable multilingual code-switching. Overrides the agent default.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}

export class CreateStreamingJobRequest {
  @ApiPropertyOptional({
    description: 'TASK-861 — the ASR Agent VERSION id that will run the job (rows are versions). Required, with `resolvedSpec`.',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentVersionId?: string;

  @ApiPropertyOptional({
    description:
      'TASK-861 — the gateway-resolved `ResolvedAsrSpec` snapshot for this job. Set by the gateway, never by a client; persisted so the job is reproducible from its own row.',
  })
  @IsObject()
  @IsOptional()
  resolvedSpec?: Record<string, unknown>;

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
    description: 'Language hint (ISO 639-1 code, e.g. "en", "ml"). Overrides the agent default.',
    example: 'en',
  })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description: 'Enable multilingual code-switching. Overrides the agent default.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}
