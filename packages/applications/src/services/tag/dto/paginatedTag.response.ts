import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { TagResponse } from '.';

export class PaginatedTagResponse extends PaginatedResponse<TagResponse> {
  @ApiProperty({ type: [TagResponse] })
  override readonly data!: readonly TagResponse[];
}
