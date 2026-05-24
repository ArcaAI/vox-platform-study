import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class ImpersonateRequest {
  @ApiProperty({
    description: 'ID of the user to impersonate',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsNotEmpty({ message: 'Target user ID is required' })
  targetUserId: string;

  /**
   * TASK-295 H-3: optional tenant the admin wants to impersonate the target
   * "as". Must be one of the target user's enabled `UserRoleAssignment.tenantId`
   * values. For non-SUPER_ADMIN callers it MUST equal the admin's own tenant.
   * If omitted, the controller picks the first enabled assignment for backward
   * compatibility.
   */
  @ApiProperty({
    description:
      "Optional tenantId to scope the impersonation to. Must be one of the target user's enabled tenant assignments. For tenant admins it must match their own tenant.",
    required: false,
  })
  @IsOptional()
  @IsString()
  targetTenantId?: string;
}

export class ImpersonateUserResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  username: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ type: [String] })
  roles: string[];

  @ApiProperty({ type: [String] })
  permissions: string[];

  @ApiProperty({ description: 'Tenant ID of the impersonated user', required: false })
  tenantId?: string;

  constructor(init: { id: string; username: string; email: string; roles: string[]; permissions: string[]; tenantId?: string }) {
    this.id = init.id;
    this.username = init.username;
    this.email = init.email;
    this.roles = init.roles;
    this.permissions = init.permissions;
    this.tenantId = init.tenantId;
  }
}

export class ImpersonateResponse {
  @ApiProperty({ type: ImpersonateUserResponse })
  user: ImpersonateUserResponse;

  @ApiProperty({
    description: 'Scoped JWT token for the impersonated user',
  })
  @IsString()
  token: string;

  @ApiProperty({
    description: 'ID of the admin who initiated the impersonation',
  })
  @IsString()
  impersonatedBy: string;
}
