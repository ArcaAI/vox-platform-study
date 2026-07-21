import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { UserMediaResponse } from '.';

export class PaginatedUserMediaResponse extends PaginatedResponse<UserMediaResponse> {
  @ApiProperty({ type: [UserMediaResponse] })
  override readonly data!: readonly UserMediaResponse[];
}
