import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

/** TASK-974 §4.1 — what a caller may say a sample IS. Explainability only; it gates nothing. */
export const DNA_WRITING_SAMPLE_KINDS = ['CASE_NOTE', 'WORK_NOTE', 'OTHER'] as const;

/** §4.1 — per-batch bounds. Enforced here (per item) and in the service (the total). */
export const DNA_INGEST_LIMITS = {
  maxItems: 200,
  maxItemChars: 20_000,
  /** Σ over `text`. Cross-field, so the service enforces it — a decorator cannot see the siblings. */
  maxTotalChars: 400_000,
} as const;

/**
 * ONE writing sample.
 *
 * `writtenAt` is REQUIRED and is the reason this endpoint exists: the platform already accepted
 * an unordered `string[]` (`textSamples`), and an unordered bag cannot express a writing style's
 * TRAJECTORY — nor be truncated in a way that keeps what the clinician writes today.
 */
export class DnaWritingSampleDto {
  @ApiProperty({ description: 'The writing sample itself — a case note, work note, or any prose the clinician authored.', maxLength: 20000 })
  @IsString()
  @MinLength(1)
  @MaxLength(DNA_INGEST_LIMITS.maxItemChars)
  text!: string;

  @ApiProperty({
    description: 'When the clinician wrote it (ISO-8601 date-time). The time-series key: the corpus is ordered by it, and the oldest items are dropped first when the batch exceeds the context budget.',
    example: '2026-09-01T09:30:00.000Z',
  })
  @IsISO8601()
  writtenAt!: string;

  @ApiPropertyOptional({
    description: 'What kind of writing this is. Recorded on the report as a count per kind; it never changes how the sample is treated.',
    enum: DNA_WRITING_SAMPLE_KINDS,
    default: 'OTHER',
  })
  @IsOptional()
  @IsIn(DNA_WRITING_SAMPLE_KINDS)
  kind?: (typeof DNA_WRITING_SAMPLE_KINDS)[number];

  @ApiPropertyOptional({
    description:
      "The caller's own record locator for this sample (an EMR note id, say). Carried in the job for support and NEVER persisted on the report — it is the caller's identifier for a clinical record.",
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourceRef?: string;
}

/**
 * TASK-974 §4.1 — `POST /api/v1/dna-writing-styles/ingest`.
 *
 * The global pipe runs `whitelist + forbidNonWhitelisted`, so every accepted field is declared
 * here and anything else rejects the request.
 */
export class IngestDnaWritingSamplesRequest {
  @ApiPropertyOptional({
    description:
      'The clinician these samples belong to. REQUIRED for an API-key or service-account caller — a machine is never itself the clinician. A human caller omits it to ingest their OWN samples; a tenant or super admin may name another clinician of their tenant.',
    format: 'uuid',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  clinicianUserId?: string;

  @ApiProperty({
    description: `The writing samples, in any order — the server sorts them by \`writtenAt\`. At most ${DNA_INGEST_LIMITS.maxItems} items and ${DNA_INGEST_LIMITS.maxTotalChars} characters in total.`,
    type: [DnaWritingSampleDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DNA_INGEST_LIMITS.maxItems)
  @ValidateNested({ each: true })
  @Type(() => DnaWritingSampleDto)
  items!: DnaWritingSampleDto[];
}
