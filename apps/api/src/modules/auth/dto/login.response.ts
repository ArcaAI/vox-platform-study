import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsArray, IsOptional } from 'class-validator';
import { UserSession } from '@arcaai/applications';

export class LoginUserResponse extends UserSession {
  @ApiProperty()
  @IsString()
  username: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  roles: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  permissions: string[];

  @ApiPropertyOptional({
    description: 'Tenant ID the user is authenticated against. Empty for global admins with global access.',
    example: '50000000-0000-0000-0000-000000000000',
  })
  @IsOptional()
  @IsString()
  tenantId?: string;

  @ApiPropertyOptional({
    description: 'Tenant key the user is authenticated against. Empty for global admins with global access.',
    example: 'acme-hospital',
  })
  @IsOptional()
  @IsString()
  tenantKey?: string;

  constructor(init: Partial<LoginUserResponse> & { id: string; email: string }) {
    super({
      id: init.id,
      email: init.email,
      firstName: init.firstName,
      lastName: init.lastName,
      phone: init.phone,
      tenantId: init.tenantId,
      tenantCode: init.tenantCode,
      token: init.token,
    });
    this.username = init.username!;
    this.roles = init.roles || [];
    this.permissions = init.permissions || [];
    this.tenantId = init.tenantId || '';
    this.tenantKey = init.tenantKey || '';
  }
}

export class LoginResponse {
  @ApiProperty({ type: LoginUserResponse })
  user: LoginUserResponse;

  @ApiProperty({
    description: 'JWT access token',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @IsString()
  token: string;

  @ApiProperty({
    description: 'Refresh token for obtaining new access tokens',
    example: 'refresh_token_string',
  })
  @IsString()
  refreshToken: string;

  // TASK-400 — rotation policy surfaced at login as a NON-BLOCKING warning
  // flag: true when `security.password.maxAgeDays` > 0 and the password is
  // older than the window. Login still succeeds; the client decides how to
  // nudge. Absent/false when rotation is disabled (default) or not exceeded.
  @ApiPropertyOptional({
    description: 'True when the password rotation window has been exceeded (warning only; login is not blocked)',
    example: false,
  })
  @IsOptional()
  passwordExpired?: boolean;
}
