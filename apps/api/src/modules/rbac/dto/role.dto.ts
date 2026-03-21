import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsUUID, IsArray, IsNumber, Min, IsIn } from 'class-validator';

/**
 * DTO for creating a new role
 */
export class CreateRoleDto {
    @ApiProperty({ description: 'Role name', example: 'MANAGER' })
    @IsString()
    name: string;

    @ApiPropertyOptional({ description: 'Role description', example: 'Team manager with elevated permissions' })
    @IsOptional()
    @IsString()
    description?: string;

    @ApiPropertyOptional({ description: 'External name for display', example: 'Manager' })
    @IsOptional()
    @IsString()
    externalName?: string;

    @ApiPropertyOptional({ description: 'External ID for integration', example: 'ext-role-123' })
    @IsOptional()
    @IsString()
    externalId?: string;

    @ApiPropertyOptional({ description: 'Parent role ID for inheritance', example: '01234567-89ab-cdef-0123-456789abcdef' })
    @IsOptional()
    @IsUUID()
    parentRoleId?: string;
}

/**
 * DTO for updating a role
 */
export class UpdateRoleDto {
    @ApiPropertyOptional({ description: 'Role name', example: 'MANAGER' })
    @IsOptional()
    @IsString()
    name?: string;

    @ApiPropertyOptional({ description: 'Role description', example: 'Team manager with elevated permissions' })
    @IsOptional()
    @IsString()
    description?: string;

    @ApiPropertyOptional({ description: 'External name for display', example: 'Manager' })
    @IsOptional()
    @IsString()
    externalName?: string;

    @ApiPropertyOptional({ description: 'External ID for integration', example: 'ext-role-123' })
    @IsOptional()
    @IsString()
    externalId?: string;

    @ApiPropertyOptional({ description: 'Parent role ID for inheritance', example: '01234567-89ab-cdef-0123-456789abcdef' })
    @IsOptional()
    @IsUUID()
    parentRoleId?: string;

    @ApiPropertyOptional({ description: 'Resource status (ENABLED or DISABLED)', enum: ['ENABLED', 'DISABLED'] })
    @IsOptional()
    @IsIn(['ENABLED', 'DISABLED'])
    resourceStatus?: string;
}

/**
 * DTO for assigning a policy to a role
 */
export class AssignPolicyToRoleDto {
    @ApiPropertyOptional({ 
        description: 'Priority of the policy (lower = higher priority)', 
        example: 0,
        default: 0,
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    priority?: number;
}

/**
 * Role response DTO
 */
export class RoleResponse {
    @ApiProperty({ description: 'Role ID' })
    id: string;

    @ApiProperty({ description: 'Role name' })
    name: string;

    @ApiPropertyOptional({ description: 'Role description' })
    description?: string;

    @ApiPropertyOptional({ description: 'External name for display' })
    externalName?: string;

    @ApiPropertyOptional({ description: 'External ID for integration' })
    externalId?: string;

    @ApiProperty({ description: 'Whether this is a system role (cannot be deleted)' })
    isSystemRole: boolean;

    @ApiPropertyOptional({ description: 'Parent role ID' })
    parentRoleId?: string;

    @ApiProperty({ description: 'Resource status' })
    resourceStatus: string;

    @ApiProperty({ description: 'Created at timestamp' })
    createdAt: Date;

    @ApiProperty({ description: 'Updated at timestamp' })
    updatedAt: Date;

    @ApiPropertyOptional({ description: 'Associated policies' })
    policies?: PolicySummary[];
}

/**
 * Policy summary for role response
 */
export class PolicySummary {
    @ApiProperty({ description: 'Policy ID' })
    id: string;

    @ApiProperty({ description: 'Policy name' })
    name: string;

    @ApiProperty({ description: 'Priority in this role' })
    priority: number;
}

/**
 * Paginated role response
 */
export class PaginatedRoleResponse {
    @ApiProperty({ type: [RoleResponse], description: 'List of roles' })
    data: RoleResponse[];

    @ApiProperty({ description: 'Total count' })
    total: number;

    @ApiProperty({ description: 'Page number' })
    page: number;

    @ApiProperty({ description: 'Page size' })
    pageSize: number;
}
