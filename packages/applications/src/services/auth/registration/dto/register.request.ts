import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsNotEmpty } from 'class-validator';

/**
 * TASK-497 §3.4 (D1 verified self-signup) — `POST /auth/register`. Password
 * complexity is enforced downstream by `UserService.create` (the configurable
 * GlobalSettings policy is the single validation voice — mirrors TASK-400 §5.2).
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
