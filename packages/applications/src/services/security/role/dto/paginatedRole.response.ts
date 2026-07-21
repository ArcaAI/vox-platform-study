import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { RoleResponse } from '.';

export class PaginatedRoleResponse extends PaginatedResponse<RoleResponse> {
  @ApiProperty({ type: [RoleResponse] })
  override readonly data!: readonly RoleResponse[];
}
