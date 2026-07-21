import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { UserProfileResponse } from '.';

export class PaginatedUserProfileResponse extends PaginatedResponse<UserProfileResponse> {
  @ApiProperty({ type: [UserProfileResponse] })
  override readonly data!: readonly UserProfileResponse[];
}
