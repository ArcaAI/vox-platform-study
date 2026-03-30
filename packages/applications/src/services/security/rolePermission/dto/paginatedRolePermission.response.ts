import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { RolePermissionResponse } from '.';

// TODO: Implement this

export class PaginatedRolePermissionResponse extends PaginatedResponse<RolePermissionResponse> {
  @ApiProperty({ type: [RolePermissionResponse] })
  override readonly data!: readonly RolePermissionResponse[];
}
