import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * The offset-pagination defaults. Applied here, at the DTO
 * layer, so the RAW (post-transform) `page`/`limit` already equal the
 * EFFECTIVE values applied to the query — a single source of truth shared by
 * the Swagger `default` annotations below, `withFormattedPaginatedProps`
 * (`../paginatedQueryParamConverters.ts`, which imports these), and every
 * response envelope that echoes back `props.page`/`props.limit` unchanged.
 * Previously the default only existed downstream in
 * `withFormattedPaginatedProps` (`props.limit || DEFAULT_PAGE_SIZE`), so an
 * omitted `limit` queried 10 rows but echoed `limit: 0` in the envelope.
 */
export const DEFAULT_PAGE = 0;
export const DEFAULT_PAGE_SIZE = 10;

export class PaginatedQuery {
  @IsOptional()
  @ApiProperty({
    description: 'Page number (starting from 0)',
    example: 0,
    required: false,
    default: DEFAULT_PAGE,
  })
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(0)
  page?: number = DEFAULT_PAGE;

  @IsOptional()
  @ApiProperty({
    description: 'Number of items per page (10, 20, or 50)',
    example: 10,
    required: false,
    default: DEFAULT_PAGE_SIZE,
  })
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @ApiProperty({
    description: 'Search query',
    required: false,
    default: '',
  })
  search?: string;

  @IsOptional()
  @ApiProperty({
    description: 'Search fields (comma separated: name,phoneNumber)',
    required: false,
    default: '',
  })
  searchFields?: string;

  @IsOptional()
  @ApiProperty({
    description:
      "Filters, ';'-separated, each token `field[op]:value` — e.g. `status[equals]:ACTIVE;name[contains]:Jo`. " +
      'The operator is REQUIRED: a token without `[op]` does not match the grammar and is dropped, which ' +
      'returns the UNFILTERED set rather than an error. Operators include equals/not/lt/lte/gt/gte/contains/' +
      'startsWith/endsWith, the case-insensitive iequals/icontains/istartsWith/iendsWith, the list in/notIn ' +
      "('|'-separated values), and AND[…]/OR[…] groups. See `deserializeFilterString`.",
    required: false,
    default: '',
  })
  filters?: string;

  @IsOptional()
  @ApiProperty({
    description: 'Sort (comma separated: name:asc,phoneNumber:desc)',
    required: false,
    default: '',
  })
  sort?: string;
}
