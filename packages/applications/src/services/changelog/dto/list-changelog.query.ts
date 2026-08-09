import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ChangelogSeverity } from '@arcaai/domains';
import { PaginatedQuery } from '../../../common';

/**
 * Query for `GET /changelog`.
 *
 * `version` is an AMENDMENT to the U0 frozen contract (which lists only
 * `severity` + `page`): §6b calls for a URL-shareable version filter and the
 * U11 console client sends it. Matched as a prefix on `platformVersion`.
 */
export class ListChangelogQuery extends PaginatedQuery {
  @ApiPropertyOptional({ enum: ChangelogSeverity })
  @IsOptional()
  @IsEnum(ChangelogSeverity)
  severity?: ChangelogSeverity;

  @ApiPropertyOptional({ description: 'Platform version prefix, e.g. `2.1`' })
  @IsOptional()
  @IsString()
  version?: string;
}
