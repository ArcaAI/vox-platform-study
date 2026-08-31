import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Max, Min } from 'class-validator';

/**
 * The paging/filter window for the three MLflow read proxies.
 *
 * Every accepted field is declared here because the global `ValidationPipe`
 * runs `whitelist + forbidNonWhitelisted + forbidUnknownValues` — an undeclared
 * query param rejects the request rather than being silently forwarded to
 * MLflow. That is deliberate: this DTO is the seam that stops the proxy from
 * becoming an arbitrary pass-through to an unauthenticated tracking server.
 *
 * `filter` is MLflow's own search-filter grammar and is forwarded verbatim. It
 * is length-capped only; MLflow parses (and rejects) it, and a parse failure
 * comes back as its own 400 through the proxy's upstream-error passthrough.
 */
export class MlflowSearchQuery {
  @ApiProperty({
    required: false,
    maxLength: 1000,
    description: "MLflow search-filter expression, forwarded verbatim (e.g. `name LIKE 'whisper%'`). A malformed filter returns MLflow's own 400.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  filter?: string;

  @ApiProperty({
    required: false,
    minimum: 1,
    maximum: 1000,
    description: 'Page size. Capped so one console read can never ask MLflow for an unbounded scan.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  maxResults?: number;

  @ApiProperty({ required: false, maxLength: 4000, description: 'Opaque continuation token from a previous response `next_page_token`.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  pageToken?: string;

  @ApiProperty({ required: false, maxLength: 200, description: 'MLflow order-by clause, e.g. `last_updated_timestamp DESC`.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  orderBy?: string;
}
