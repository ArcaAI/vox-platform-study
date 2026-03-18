import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { PolicyRuleDto } from './policy.dto';

/**
 * Role summary for user assignment response
 * Note: Declared first to avoid "used before declaration" error
 */
export class RoleSummary {
    @ApiProperty({ description: 'Role ID' })
    id: string;

    @ApiProperty({ description: 'Role name' })
    name: string;

    @ApiPropertyOptional({ description: 'Role description' })
    description?: string;
}

/**
 * Scope overrides DTO
 */
export class ScopeOverridesDto {
    @ApiPropertyOptional({ 
        description: 'Additional rules to add for this assignment',
        type: [PolicyRuleDto],
    })
    @IsOptional()
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => PolicyRuleDto)
    additionalRules?: PolicyRuleDto[];

    @ApiPropertyOptional({ 
        description: 'Policy IDs to exclude from this assignment',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    excludedPolicies?: string[];
}

/**
 * DTO for assigning a role to a user
 */
export class AssignRoleToUserDto {
    @ApiPropertyOptional({ 
        description: 'Tenant ID for tenant-scoped assignment',
        example: '01234567-89ab-cdef-0123-456789abcdef',
    })
    @IsOptional()
    @IsUUID()
    tenantId?: string;

    @ApiPropertyOptional({ 
        description: 'Scope overrides for this specific assignment',
        example: {
            additionalRules: [{ action: 'read', subject: 'SpecialResource' }],
            excludedPolicies: ['some-policy-id'],
        },
    })
    @IsOptional()
    scopeOverrides?: ScopeOverridesDto;
}

/**
 * User role assignment response
 */
export class UserRoleAssignmentResponse {
    @ApiProperty({ description: 'Assignment ID' })
    id: string;

    @ApiProperty({ description: 'User ID' })
    userId: string;

    @ApiPropertyOptional({ description: 'Tenant ID' })
    tenantId?: string;

    @ApiProperty({ description: 'Assigned roles', type: [RoleSummary] })
    roles: RoleSummary[];

    @ApiPropertyOptional({ description: 'Scope overrides' })
    scopeOverrides?: ScopeOverridesDto;

    @ApiProperty({ description: 'Resource status' })
    resourceStatus: string;

    @ApiProperty({ description: 'Created at timestamp' })
    createdAt: Date;

    @ApiProperty({ description: 'Updated at timestamp' })
    updatedAt: Date;
}

/**
 * User's effective permissions response
 */
export class UserEffectivePermissionsResponse {
    @ApiProperty({ description: 'User ID' })
    userId: string;

    @ApiPropertyOptional({ description: 'Tenant ID context' })
    tenantId?: string;

    @ApiProperty({ description: 'Assigned roles', type: [RoleSummary] })
    roles: RoleSummary[];

    @ApiProperty({ 
        description: 'Effective permissions (all rules from all policies)',
        type: [PolicyRuleDto],
    })
    permissions: PolicyRuleDto[];

    @ApiProperty({ description: 'Timestamp when permissions were calculated' })
    calculatedAt: Date;
}
