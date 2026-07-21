import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Generic cursor (keyset) request DTO.
 *
 * Symmetric counterpart of the offset {@link PaginatedQuery}. `cursor` is the
 * opaque token returned as the previous page's `nextCursor` (omit it for the
 * first page); `limit` is clamped server-side to `[1, MAX_CURSOR_LIMIT]`.
 */
export class CursorQuery {
  @IsOptional()
  @IsString()
  @ApiProperty({
    description: "Opaque cursor token from the previous page's `nextCursor`. Omit for the first page.",
    required: false,
  })
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @ApiProperty({
    description: 'Number of items per page (clamped to 1–100).',
    example: 10,
    required: false,
    default: 10,
  })
  limit?: number;

  /**
   * The CSV `field[op]:value` (`;`-separated) filter contract — the symmetric
   * counterpart of {@link PaginatedQuery.filters}. A cursor consumer threads
   * this through `deserializeFilterString(filters, <modelName>)` so values are
   * coerced to their column's scalar type identically to the
   * offset path before the keyset query runs.
   */
  @IsOptional()
  @IsString()
  @ApiProperty({
    description: 'Filters (CSV: field[op]:value, e.g. success[equals]:false;action[equals]:CREATE)',
    required: false,
    default: '',
  })
  filters?: string;
}
