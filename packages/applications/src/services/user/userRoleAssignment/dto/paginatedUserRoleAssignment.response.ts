import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../../common';
import { UserRoleAssignmentResponse } from '.';

// TODO: Implement this

export class PaginatedUserRoleAssignmentResponse extends PaginatedResponse<UserRoleAssignmentResponse> {
    @ApiProperty({ type: [UserRoleAssignmentResponse] })
    override readonly data!: readonly UserRoleAssignmentResponse[];
}
