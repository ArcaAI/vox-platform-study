import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateUserRoleAssignmentRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the user (set from URL)', required: false })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiProperty({ description: 'ID of the role to assign' })
  @IsString()
  roleId!: string;

  // TODO: migrate to standard UUID format and restore to @IsUUID()
  @ApiPropertyOptional({ description: 'Tenant ID for tenant-scoped assignment. Null = global assignment.' })
  @IsOptional()
  @IsString()
  tenantId?: string;
}
