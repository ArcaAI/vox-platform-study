import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { UserSettingsResponse } from '.';

// TODO: Implement this

export class PaginatedUserSettingsResponse extends PaginatedResponse<UserSettingsResponse> {
  @ApiProperty({ type: [UserSettingsResponse] })
  override readonly data!: readonly UserSettingsResponse[];
}
