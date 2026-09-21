import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { TranscriptionJobType } from '@arcaai/domains';

/**
 * TASK-999 §3.1 C-2 — the admin transcription-job list query.
 *
 * Declared as a class rather than three loose `@Query('name')` params because the
 * global pipe runs `whitelist + forbidNonWhitelisted`: an undeclared field on a
 * validated query object is a 400, not a silently-dropped one. `page`/`limit`
 * keep their existing names and defaults so the console's current call is
 * unchanged.
 *
 * `jobType` is ABSENT-means-both. Realtime sessions only became rows in TASK-999,
 * so a caller that does not ask for a kind must keep seeing everything the tenant
 * has — filtering to `BATCH` by default would hide the new rows from every
 * existing reader.
 */
export class ListTranscriptionJobsQuery {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Rows per page', default: 20, minimum: 1, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'TASK-999 — restrict to one kind of job. Omit for BOTH kinds (batch jobs and realtime sessions).',
    enum: TranscriptionJobType,
  })
  @IsEnum(TranscriptionJobType)
  @IsOptional()
  jobType?: TranscriptionJobType;
}
