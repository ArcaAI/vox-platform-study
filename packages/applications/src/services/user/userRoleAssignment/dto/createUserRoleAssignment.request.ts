import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateUserRoleAssignmentRequest extends BaseRequest {
    @ApiProperty({ description: 'ID of the user (set from URL)', required: false })
    @IsOptional()
    @IsString()
    userId?: string;

    @ApiProperty({ description: 'ID of the role to assign' })
    @IsString()
    roleId!: string;

    @ApiPropertyOptional({ description: 'Tenant ID for tenant-scoped assignment. Null = global assignment.' })
    @IsOptional()
    @IsUUID()
    tenantId?: string;
}
