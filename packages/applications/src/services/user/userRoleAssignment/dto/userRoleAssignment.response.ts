import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';

export class UserRoleAssignmentResponse extends BaseResponse {
  @ApiProperty({ description: 'ID of the user' })
  userId!: string;

  @ApiProperty({ description: 'ID of the assigned role' })
  roleId!: string;

  @ApiPropertyOptional({ description: 'Name of the assigned role' })
  roleName?: string;

  @ApiPropertyOptional({ description: 'Tenant ID for scoped assignment' })
  tenantId!: string | null;

  constructor(init: UserRoleAssignmentResponse & BaseResponseProps) {
    super(init);
    this.userId = init.userId;
    this.roleId = init.roleId;
    this.roleName = init.roleName;
    this.tenantId = init.tenantId ?? null;
  }
}
