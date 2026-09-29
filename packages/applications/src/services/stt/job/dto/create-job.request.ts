import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsEnum, IsNumber, IsBoolean, IsUUID, Min, Max } from 'class-validator';
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
      'The published ASR Agent to run the job, by slug. Absent = the tenant`s assigned ASR agent (the same cascade as `POST …/transcribe`).',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentSlug?: string;

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

  /**
   * @deprecated TASK-1012 L-7 — ignored since TASK-1004 (the worker takes the language mode from
   * the resolved agent spec). Still declared so an integration that sends it is not refused.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored — code-switching is the resolved ASR agent`s language mode, not a per-job flag.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}

export class CreateBatchJobRequest {
  @ApiPropertyOptional({
    description:
      'The published ASR Agent to run the job, by slug. Absent = the tenant`s assigned ASR agent (the same cascade as `POST …/transcribe`).',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentSlug?: string;

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

  /**
   * @deprecated TASK-1012 L-7 — ignored since TASK-1004 (the worker takes the language mode from
   * the resolved agent spec). Still declared so an integration that sends it is not refused.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored — code-switching is the resolved ASR agent`s language mode, not a per-job flag.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}

export class CreateStreamingJobRequest {
  @ApiPropertyOptional({
    description:
      'The published ASR Agent to run the job, by slug. Absent = the tenant`s assigned ASR agent (the same cascade as `POST …/transcribe`).',
  })
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  agentSlug?: string;

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

  /**
   * @deprecated TASK-1012 L-7 — ignored since TASK-1004 (the worker takes the language mode from
   * the resolved agent spec). Still declared so an integration that sends it is not refused.
   */
  @ApiPropertyOptional({
    deprecated: true,
    description: 'Ignored — code-switching is the resolved ASR agent`s language mode, not a per-job flag.',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  codeSwitching?: boolean;
}

/**
 * TASK-1012 L-7 — the ASR agent a job runs on, as the GATEWAY resolved it (`agentSlug` or the
 * assignment cascade → `AsrAgentResolverService`). Service input only: the public request DTOs
 * above deliberately do NOT declare these fields, so a caller can never hand in its own engine
 * chain (the strict global pipe 400s both).
 */
export interface ResolvedAsrJobSelection {
  /** The ASR Agent VERSION id that runs the job (rows are versions). */
  agentVersionId: string;
  /** The resolved `ResolvedAsrSpec` snapshot, persisted so the job is reproducible from its own row. */
  resolvedSpec: Record<string, unknown>;
}

/** {@link CreateJobRequest} after the gateway resolved its agent. */
export type CreateJobInput = Omit<CreateJobRequest, 'agentSlug'> & ResolvedAsrJobSelection;

/** {@link CreateBatchJobRequest} after the gateway resolved its agent. */
export type CreateBatchJobInput = Omit<CreateBatchJobRequest, 'agentSlug'> & ResolvedAsrJobSelection;

/** {@link CreateStreamingJobRequest} after the gateway resolved its agent. */
export type CreateStreamingJobInput = Omit<CreateStreamingJobRequest, 'agentSlug'> & ResolvedAsrJobSelection;
