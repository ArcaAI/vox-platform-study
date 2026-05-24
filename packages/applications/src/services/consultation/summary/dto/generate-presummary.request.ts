import { IsString, IsOptional, IsObject, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GeneratePreSummaryRequest {
  @ApiPropertyOptional({ description: 'DNA Style ID for pre-summarization' })
  @IsOptional()
  @IsString()
  dnaStyleId?: string;

  @ApiPropertyOptional({ description: 'Specific case note IDs to use (if not provided, uses all case notes)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  caseNoteIds?: string[];

  @ApiPropertyOptional({ description: 'Additional options for pre-summarization' })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;

  /** TASK-299 D-10 — Idempotency-Key for safe POST retries / double-clicks. */
  @ApiPropertyOptional({ description: 'Idempotency key (UUID) — duplicate POSTs return the prior jobId.' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
