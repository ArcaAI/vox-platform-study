import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { DNA_SAMPLE_SOURCES, DnaSampleSourceName } from './dna-memory.constants';

// ─── TASK-1034 — DNA writing-style MEMORY admin surface ───────────────────────────

export class DnaMemorySourceCounts {
  @ApiProperty({ example: 4 }) EDIT!: number;
  @ApiProperty({ example: 2 }) SIGNOFF!: number;
  @ApiProperty({ example: 20 }) INGEST!: number;
}

/** One clinician's memory roll-up. */
export class DnaMemoryDoctorSummaryResponse {
  @ApiProperty({ format: 'uuid' }) doctorId!: string;
  @ApiProperty({ type: String, nullable: true }) username!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'First and last name from the user profile, when set.' }) displayName!: string | null;
  @ApiProperty({ description: 'Live memory samples (soft-deleted ones excluded).', example: 26 }) total!: number;
  @ApiProperty({ description: 'Samples no report has consumed yet.', example: 5 }) unconsumed!: number;
  @ApiProperty({ type: DnaMemorySourceCounts }) bySource!: DnaMemorySourceCounts;
  @ApiProperty({ type: String, nullable: true, description: 'ISO time of the newest sample.' }) lastSampleAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'ISO time of the latest DNA report.' }) lastReportAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) latestReportId!: string | null;
  @ApiProperty({ description: 'The effective DNA decision (tenant graph AND the clinician`s own opt-in).' }) dnaEnabled!: boolean;
}

export class ListDnaMemoryQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this clinician`s samples.' })
  @IsOptional()
  @IsString()
  doctorId?: string;

  @ApiPropertyOptional({ enum: DNA_SAMPLE_SOURCES })
  @IsOptional()
  @IsIn(DNA_SAMPLE_SOURCES)
  source?: DnaSampleSourceName;

  @ApiPropertyOptional({ description: '`true` = consumed by a report, `false` = not yet.' })
  @IsOptional()
  @Transform(({ value }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value))
  @IsBoolean()
  consumed?: boolean;

  @ApiPropertyOptional({ description: 'Page number (starting from 1).', default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Page size.', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** One memory sample, never its full text: a ≤200-character PHI-redacted preview. */
export class DnaMemorySampleResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) doctorId!: string;
  @ApiProperty({ enum: DNA_SAMPLE_SOURCES }) source!: DnaSampleSourceName;
  @ApiProperty({ type: String, nullable: true }) kind!: string | null;
  @ApiProperty({ description: 'ISO time the clinician wrote it.' }) writtenAt!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The ingesting caller`s own record locator, when given.' }) sourceRef!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) consultationId!: string | null;
  @ApiProperty() consumed!: boolean;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) consumedByReportId!: string | null;
  @ApiProperty({ description: 'At most 200 characters, PHI-redacted. Empty when redaction is unavailable.' }) preview!: string;
  @ApiProperty() createdAt!: string;
}

export class DnaMemorySamplePageResponse {
  @ApiProperty({ type: [DnaMemorySampleResponse] }) data!: DnaMemorySampleResponse[];
  @ApiProperty({ example: 42 }) count!: number;
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
}

export class DnaRegenSkipCountsResponse {
  @ApiProperty() noFeedback!: number;
  @ApiProperty() optedOut!: number;
  @ApiProperty() quota!: number;
  @ApiProperty() belowFloor!: number;
}

export class DnaRegenLastRunResponse {
  @ApiProperty({ description: 'ISO time of the run.' }) at!: string;
  @ApiProperty() queued!: number;
  @ApiProperty({ type: DnaRegenSkipCountsResponse }) skipped!: DnaRegenSkipCountsResponse;
}

export class DnaRegenScheduleResponse {
  @ApiProperty() enabled!: boolean;
  @ApiProperty({ example: '0 2 * * 1' }) cron!: string;
  @ApiProperty({ example: 3 }) minNewSamples!: number;
  @ApiProperty({ example: 'Asia/Kolkata', description: 'The tenant`s consultation time zone the cron is read in.' }) timeZone!: string;
  @ApiProperty({ type: String, nullable: true, description: 'ISO time of the next run; null when disabled.' }) nextRunAt!: string | null;
  @ApiProperty({ type: DnaRegenLastRunResponse, nullable: true }) lastRun!: DnaRegenLastRunResponse | null;
}

export class UpdateDnaRegenScheduleRequest {
  @ApiPropertyOptional({ description: 'Turn this tenant`s weekly regeneration on or off.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: '0 2 * * 1', description: 'Cron expression, read in the tenant time zone.' })
  @IsOptional()
  @IsString()
  cron?: string;

  @ApiPropertyOptional({ example: 3, minimum: 1, description: 'Minimum new memory samples before a clinician is regenerated.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  minNewSamples?: number;
}

export class DnaRegenRunJobResponse {
  @ApiProperty({ format: 'uuid' }) doctorId!: string;
  @ApiProperty() jobId!: string;
}

export class DnaRegenRunResponse {
  @ApiProperty() queued!: number;
  @ApiProperty({ type: DnaRegenSkipCountsResponse }) skipped!: DnaRegenSkipCountsResponse;
  @ApiProperty({ type: [DnaRegenRunJobResponse] }) jobs!: DnaRegenRunJobResponse[];
}
