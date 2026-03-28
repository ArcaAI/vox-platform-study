import { ApiProperty } from '@nestjs/swagger';

export class Paginated<T> {
  readonly count: number;
  readonly limit: number;
  readonly page: number;
  readonly data: readonly T[];

  constructor(props: Paginated<T>) {
    this.count = props.count;
    this.limit = props.limit;
    this.page = props.page;
    this.data = props.data;
  }
}

export abstract class PaginatedResponse<T> extends Paginated<T> {
  @ApiProperty({
    example: 1234,
    description: 'Total number of items',
  })
  declare readonly count: number;

  @ApiProperty({
    example: 10,
    description: 'Number of items per page',
  })
  declare readonly limit: number;

  @ApiProperty({ example: 0, description: 'Page number' })
  declare readonly page: number;

  @ApiProperty({ isArray: true })
  abstract override readonly data: readonly T[];
}
