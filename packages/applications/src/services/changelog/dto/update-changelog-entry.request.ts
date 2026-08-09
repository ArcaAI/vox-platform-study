import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';
import { ChangelogAudience, ChangelogSeverity } from '@arcaai/domains';

/**
 * Sparse patch of a release note. OCC-guarded: `expectedVersion` is the CAS
 * predicate, normally folded in from the required `If-Match` header by the
 * controller (missing header → 428, drift → 412).
 *
 * `publishStatus` is deliberately NOT patchable — DRAFT → PUBLISHED happens
 * only through `POST /admin/changelog/{id}/publish` (TASK-648 §3.5).
 */
export class UpdateChangelogEntryRequest {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  summary?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  body?: string;

  @ApiPropertyOptional({ enum: ChangelogSeverity })
  @IsOptional()
  @IsEnum(ChangelogSeverity)
  severity?: ChangelogSeverity;

  @ApiPropertyOptional({ enum: ChangelogAudience })
  @IsOptional()
  @IsEnum(ChangelogAudience)
  audience?: ChangelogAudience;

  @ApiPropertyOptional({ description: 'OCC predicate; normally folded in from `If-Match`.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
