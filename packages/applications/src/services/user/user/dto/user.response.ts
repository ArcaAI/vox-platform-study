import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';
import { UserRoleAssignmentResponse } from '../../userRoleAssignment/dto';

export class UserResponse extends BaseResponse {
  @ApiProperty({ description: 'Username of the user' })
  username!: string;

  @ApiProperty({ description: 'Last login timestamp', required: false })
  lastLoginAt?: Date;

  @ApiProperty({ description: 'Last active timestamp', required: false })
  lastActiveAt?: Date;

  @ApiProperty({ description: 'External identifier', required: false })
  externalId?: string;

  @ApiProperty({ description: 'Whether this is a service account' })
  isServiceAccount: boolean = false;

  @ApiPropertyOptional({ type: [UserRoleAssignmentResponse], description: 'Role assignments (included when includeRoles=true)' })
  UserRoleAssignments?: UserRoleAssignmentResponse[];

  @ApiPropertyOptional({
    description: 'Whether the user is the primary/lead member of this department (only set on the department-members listing)',
  })
  isLead?: boolean;

  // secret1/secret2 (and their expiries) are sensitive user
  // credentials and are deliberately NOT exposed on this response. The auto
  // entity→DTO mapper copies a field only when the target instance declares it,
  // so omitting them here keeps them out of every serialised UserResponse.
  constructor(init: UserResponse & BaseResponseProps) {
    super(init);
    this.username = init.username;
    this.lastLoginAt = init.lastLoginAt;
    this.lastActiveAt = init.lastActiveAt;
    this.externalId = init.externalId;
    this.isServiceAccount = init.isServiceAccount;
    this.UserRoleAssignments = init.UserRoleAssignments;
    this.isLead = init.isLead;
  }
}
