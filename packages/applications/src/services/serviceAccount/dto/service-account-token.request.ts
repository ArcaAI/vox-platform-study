import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * The ONLY route that ever accepts a service-account secret
 * (`POST /api/v1/auth/service-token`). Never accept it anywhere else, and never
 * put a token or a secret in a URL.
 */
export class ServiceAccountTokenRequest {
  @ApiProperty({ description: 'Public client identifier', example: 'hope_svc_2f9c1a…' })
  @IsString()
  @MaxLength(128)
  clientId!: string;

  @ApiProperty({ description: 'The client secret issued (exactly once) at creation or rotation' })
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  clientSecret!: string;

  @ApiProperty({
    description: 'PLATFORM accounts only: the working tenant to act on. Must be in the account allow-list. Ignored for a tenant-bound account.',
    required: false,
  })
  @IsOptional()
  @IsString()
  workingTenantId?: string;
}
