import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsNotEmpty, IsOptional, Max, MaxLength, Min } from 'class-validator';

export class ImpersonateRequest {
  @ApiProperty({
    description: 'ID of the user to impersonate',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsNotEmpty({ message: 'Target user ID is required' })
  targetUserId: string;

  /**
   * Optional tenant the admin wants to impersonate the target
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

/**
 * Request body for the super-admin-only
 * `POST /admin/users/:id/impersonate` endpoint. The target user id travels in
 * the PATH (`:id`), unlike the legacy `/auth/impersonate` body shape.
 */
export class AdminImpersonateRequest {
  @ApiProperty({
    description:
      "Optional tenantId to scope the impersonation to. Must be one of the target user's enabled tenant assignments; defaults to the oldest assignment.",
    required: false,
  })
  @IsOptional()
  @IsString()
  targetTenantId?: string;

  @ApiProperty({
    description: 'Optional free-text justification. Recorded on the audit trail (start bracket + forced audit row); never embedded in the token.',
    required: false,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiProperty({
    description:
      'Optional TTL override in seconds (10–1800), clamped to the 30-minute ceiling. Intended for automated expiry tests; production callers should omit it and ride the JWT_IMPERSONATION_EXPIRES_IN default (30m).',
    required: false,
    minimum: 10,
    maximum: 1800,
  })
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1800)
  expiresInSeconds?: number;
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

  // Primary department of the impersonated user in the
  // impersonation tenant; lets the SDK preference cascade keep the doctor's
  // department tier during impersonation.
  @ApiProperty({ description: 'Primary department ID of the impersonated user in the impersonation tenant', required: false })
  departmentId?: string;

  constructor(init: {
    id: string;
    username: string;
    email: string;
    roles: string[];
    permissions: string[];
    tenantId?: string;
    departmentId?: string;
  }) {
    this.id = init.id;
    this.username = init.username;
    this.email = init.email;
    this.roles = init.roles;
    this.permissions = init.permissions;
    this.tenantId = init.tenantId;
    this.departmentId = init.departmentId;
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

  // Expiry surfaced so the FE can render the countdown without
  // decoding the JWT. Set by the admin endpoint only; the legacy
  // `/auth/impersonate` response is unchanged (fields stay undefined).
  @ApiProperty({ description: 'ISO timestamp at which the impersonation token expires', required: false })
  expiresAt?: string;

  @ApiProperty({ description: 'Seconds until the impersonation token expires (at mint time)', required: false })
  expiresInSeconds?: number;
}
