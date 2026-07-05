import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class UserDepartmentResponse {
  @ApiProperty({ description: 'User department assignment ID' })
  id: string;

  @ApiProperty({ description: 'User the department is assigned to' })
  userId: string;

  @ApiProperty({ description: 'Assigned department ID' })
  departmentId: string;

  @ApiPropertyOptional({ description: 'Human-readable name of the assigned department' })
  departmentName?: string;

  @ApiPropertyOptional({ description: 'Short code of the assigned department' })
  departmentCode?: string;

  @ApiProperty({ description: "Whether this is the user's primary department" })
  isPrimary: boolean;

  @ApiProperty({ description: 'Owning tenant ID' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED', 'DELETED'] })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;

  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` on PATCH.',
    example: 1,
  })
  version: number;
}
