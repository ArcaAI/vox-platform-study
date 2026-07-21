import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsNotEmpty } from 'class-validator';

/**
 * Verified self-signup request body for `POST /auth/register`. Password
 * complexity is enforced downstream by `UserService.create` — the configurable
 * GlobalSettings policy is the single validation voice.
 */
export class RegisterRequest {
  @ApiProperty({ description: 'Email address — also used as the account username', example: 'doctor@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: 'Account password (validated against the configurable complexity policy)' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiProperty({ description: 'Name of the tenant to auto-provision for this account' })
  @IsString()
  @IsNotEmpty()
  tenantName!: string;

  @ApiPropertyOptional({ description: 'Display name for the account' })
  @IsOptional()
  @IsString()
  displayName?: string;
}
