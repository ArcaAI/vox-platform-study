import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

export class LoginRequest {
  @ApiProperty({
    description: 'Username for authentication',
    example: 'john_doe',
  })
  @IsString()
  @MinLength(1, { message: 'Username is required' })
  username: string;

  @ApiProperty({
    description: 'Password for authentication',
    example: 'password123',
  })
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password: string;

  @ApiPropertyOptional({
    description:
      'Tenant key for tenant-scoped authentication. Required for non-global-admin users. Global admins may omit this for global access or provide it to scope to a specific tenant.',
    example: 'acme-hospital',
  })
  @IsOptional()
  @IsString()
  tenantKey?: string;
}
