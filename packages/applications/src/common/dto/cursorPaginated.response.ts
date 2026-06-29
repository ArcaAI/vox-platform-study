import { ApiProperty } from '@nestjs/swagger';

/**
 * TASK-373 — generic cursor (keyset) response envelope.
 *
 * Mirrors the offset {@link PaginatedResponse} (same `data` array key) but
 * carries the cursor half of the client `PageResult` contract — `nextCursor`
 * (opaque, `null` on the last page) and `hasMore` — instead of `count`/`page`.
 */
export class CursorPaginated<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly limit: number;

  constructor(props: CursorPaginated<T>) {
    this.data = props.data;
    this.nextCursor = props.nextCursor;
    this.hasMore = props.hasMore;
    this.limit = props.limit;
  }
}

export abstract class CursorPaginatedResponse<T> extends CursorPaginated<T> {
  @ApiProperty({
    example: 'eyJrIjoiMjAyNi0wNi0yN1QxMDowMDowMC4wMDBaIiwiaWQiOiIuLi4ifQ',
    nullable: true,
    description: 'Opaque cursor for the next page; null when `hasMore` is false.',
  })
  declare readonly nextCursor: string | null;

  @ApiProperty({ example: true, description: 'Whether more pages are available.' })
  declare readonly hasMore: boolean;

  @ApiProperty({ example: 10, description: 'Number of items per page.' })
  declare readonly limit: number;

  @ApiProperty({ isArray: true })
  abstract override readonly data: readonly T[];
}
