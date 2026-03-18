import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, ValidateNested, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Single permission to check
 */
export class PermissionToCheck {
    @ApiProperty({ description: 'Action to check', example: 'read' })
    @IsString()
    action: string;

    @ApiProperty({ description: 'Subject/resource type', example: 'User' })
    @IsString()
    subject: string;

    @ApiPropertyOptional({ 
        description: 'Resource to check against (for resource-level checks)',
        example: { id: '123', tenantId: 'tenant-456' },
    })
    @IsOptional()
    resource?: Record<string, unknown>;
}

/**
 * DTO for checking a single permission
 */
export class CheckPermissionDto {
    @ApiProperty({ description: 'Action to check', example: 'read' })
    @IsString()
    action: string;

    @ApiProperty({ description: 'Subject/resource type', example: 'User' })
    @IsString()
    subject: string;

    @ApiPropertyOptional({ 
        description: 'Resource to check against (for resource-level checks)',
        example: { id: '123', tenantId: 'tenant-456' },
    })
    @IsOptional()
    resource?: Record<string, unknown>;

    @ApiPropertyOptional({ 
        description: 'User ID to check for (admin only, defaults to current user)',
        example: '01234567-89ab-cdef-0123-456789abcdef',
    })
    @IsOptional()
    @IsUUID()
    userId?: string;

    @ApiPropertyOptional({ 
        description: 'Tenant context for the check',
        example: '01234567-89ab-cdef-0123-456789abcdef',
    })
    @IsOptional()
    @IsUUID()
    tenantId?: string;
}

/**
 * DTO for checking multiple permissions at once
 */
export class CheckPermissionsBulkDto {
    @ApiProperty({ 
        description: 'Permissions to check',
        type: [PermissionToCheck],
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PermissionToCheck)
    permissions: PermissionToCheck[];

    @ApiPropertyOptional({ 
        description: 'User ID to check for (admin only, defaults to current user)',
        example: '01234567-89ab-cdef-0123-456789abcdef',
    })
    @IsOptional()
    @IsUUID()
    userId?: string;

    @ApiPropertyOptional({ 
        description: 'Tenant context for the check',
        example: '01234567-89ab-cdef-0123-456789abcdef',
    })
    @IsOptional()
    @IsUUID()
    tenantId?: string;
}

/**
 * Single permission check result
 */
export class PermissionCheckResult {
    @ApiProperty({ description: 'Action that was checked' })
    action: string;

    @ApiProperty({ description: 'Subject that was checked' })
    subject: string;

    @ApiProperty({ description: 'Whether the permission is allowed' })
    allowed: boolean;

    @ApiPropertyOptional({ description: 'Reason for denial (if not allowed)' })
    reason?: string;
}

/**
 * Response for single permission check
 */
export class CheckPermissionResponse {
    @ApiProperty({ description: 'Whether the permission is allowed' })
    allowed: boolean;

    @ApiProperty({ description: 'Action that was checked' })
    action: string;

    @ApiProperty({ description: 'Subject that was checked' })
    subject: string;

    @ApiPropertyOptional({ description: 'Reason for denial (if not allowed)' })
    reason?: string;

    @ApiPropertyOptional({ description: 'User ID that was checked' })
    userId?: string;

    @ApiPropertyOptional({ description: 'Tenant context that was used' })
    tenantId?: string;
}

/**
 * Response for bulk permission check
 */
export class CheckPermissionsBulkResponse {
    @ApiProperty({ description: 'User ID that was checked' })
    userId: string;

    @ApiPropertyOptional({ description: 'Tenant context that was used' })
    tenantId?: string;

    @ApiProperty({ 
        description: 'Results for each permission check',
        type: [PermissionCheckResult],
    })
    results: PermissionCheckResult[];

    @ApiProperty({ description: 'Whether all permissions are allowed' })
    allAllowed: boolean;

    @ApiProperty({ description: 'Whether any permission is allowed' })
    anyAllowed: boolean;
}
