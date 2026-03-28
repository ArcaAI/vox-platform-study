import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { RoleResponse } from '.';

// TODO: Implement this

export class PaginatedRoleResponse extends PaginatedResponse<RoleResponse> {
  @ApiProperty({ type: [RoleResponse] })
  override readonly data!: readonly RoleResponse[];
}
