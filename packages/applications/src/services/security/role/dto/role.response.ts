import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';

export class RoleResponse extends BaseResponse {
  @ApiProperty({ description: 'The name of the role' })
  name!: string;

  @ApiProperty({
    description: 'The description of the role',
    required: false,
  })
  description?: string;

  @ApiProperty({ description: 'External name for the role', required: false })
  externalName?: string;

  @ApiProperty({ description: 'External ID for the role', required: false })
  externalId?: string;

  @ApiProperty({ description: 'User role assignment ID', required: false })
  userRoleAssignmentId?: string;

  constructor(init: RoleResponse & BaseResponseProps) {
    super(init);
    this.name = init.name;
    this.description = init.description;
    this.externalName = init.externalName;
    this.externalId = init.externalId;
    this.userRoleAssignmentId = init.userRoleAssignmentId;
  }
}
