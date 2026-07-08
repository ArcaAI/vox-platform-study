import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsUUID, IsNumber, Min, IsIn } from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Users holding this role (tenant-scoped for tenant-scoped callers; platform-wide for unscoped platform admins). Present on read paths only (TASK-444).',
  })
  memberCount?: number;
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
 * TASK-444 — one member of a role: a UserRoleAssignment joined to its user.
 * `department` is the user's department in the ASSIGNMENT's tenant;
 * `resourceStatus` is the membership status, `userResourceStatus` the account.
 */
export class RoleMemberResponse {
  @ApiProperty({ description: 'Role assignment ID' })
  assignmentId: string;

  @ApiProperty({ description: 'User ID' })
  userId: string;

  @ApiProperty({ description: 'Tenant the assignment belongs to' })
  tenantId: string;

  @ApiProperty({ description: 'Login username' })
  username: string;

  @ApiProperty({ description: 'Profile display name (falls back to username)' })
  displayName: string;

  @ApiPropertyOptional({ description: 'Profile email', nullable: true })
  email: string | null;

  @ApiPropertyOptional({ description: "User's department in the assignment tenant (primary preferred)", nullable: true })
  department: string | null;

  @ApiProperty({ description: 'Membership (assignment) status' })
  resourceStatus: string;

  @ApiProperty({ description: 'User account status' })
  userResourceStatus: string;

  @ApiProperty({ description: 'When the role was assigned' })
  assignedAt: Date;
}

/**
 * TASK-444 — paginated members envelope (same shape as the other RBAC lists).
 */
export class PaginatedRoleMemberResponse {
  @ApiProperty({ type: [RoleMemberResponse], description: 'Members of the role' })
  data: RoleMemberResponse[];

  @ApiProperty({ description: 'Total count' })
  total: number;

  @ApiProperty({ description: 'Page number' })
  page: number;

  @ApiProperty({ description: 'Page size' })
  pageSize: number;
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
