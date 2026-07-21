import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { UserResponse } from '.';

export class PaginatedUserResponse extends PaginatedResponse<UserResponse> {
  @ApiProperty({ type: [UserResponse] })
  override readonly data!: readonly UserResponse[];
}
