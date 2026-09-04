import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsNumber, IsBoolean, IsObject, IsUUID, Matches, Min, Max } from 'class-validator';
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

  /** @deprecated TASK-861 — removed in R4. Supply `agentVersionId` + `resolvedSpec` (the gateway does) instead. */
  @ApiPropertyOptional({
    description: 'DEPRECATED (TASK-861, removed in R4): Pipeline ID (slug or UUID). Omit on the agent path.',
    example: '01234567-89ab-cdef-0123-456789abcdef',
    deprecated: true,
  })
  @IsString()
  @IsOptional()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (D-19)',
  })
  pipelineId?: string;

  @ApiPropertyOptional({
    description: 'TASK-861 — the ASR Agent VERSION id that will run the job (rows are versions). Required, with `resolvedSpec`, when `pipelineId` is omitted.',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentVersionId?: string;

  @ApiPropertyOptional({
    description: 'TASK-861 — the gateway-resolved `ResolvedAsrSpec` snapshot for this job. Set by the gateway, never by a client; persisted so the job is reproducible from its own row.',
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
  /** @deprecated TASK-861 — removed in R4. Supply `agentVersionId` + `resolvedSpec` instead. */
  @ApiPropertyOptional({ description: 'DEPRECATED (TASK-861, removed in R4): Pipeline ID (slug or UUID). Omit on the agent path.', deprecated: true })
  @IsString()
  @IsOptional()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (D-19)',
  })
  pipelineId?: string;

  @ApiPropertyOptional({
    description: 'TASK-861 — the ASR Agent VERSION id that will run the job (rows are versions). Required, with `resolvedSpec`, when `pipelineId` is omitted.',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentVersionId?: string;

  @ApiPropertyOptional({
    description: 'TASK-861 — the gateway-resolved `ResolvedAsrSpec` snapshot for this job. Set by the gateway, never by a client; persisted so the job is reproducible from its own row.',
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
  /** @deprecated TASK-861 — removed in R4. Supply `agentVersionId` + `resolvedSpec` instead. */
  @ApiPropertyOptional({ description: 'DEPRECATED (TASK-861, removed in R4): Pipeline ID (slug or UUID). Omit on the agent path.', deprecated: true })
  @IsString()
  @IsOptional()
  @Matches(PIPELINE_ID_PATTERN, {
    message: 'pipelineId must be a slug ([A-Za-z0-9-]) or UUID (D-19)',
  })
  pipelineId?: string;

  @ApiPropertyOptional({
    description: 'TASK-861 — the ASR Agent VERSION id that will run the job (rows are versions). Required, with `resolvedSpec`, when `pipelineId` is omitted.',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentVersionId?: string;

  @ApiPropertyOptional({
    description: 'TASK-861 — the gateway-resolved `ResolvedAsrSpec` snapshot for this job. Set by the gateway, never by a client; persisted so the job is reproducible from its own row.',
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
