import { ArrayNotEmpty, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, Validate } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ValidServiceAccountScopesConstraint } from './create-service-account.request';

/**
 * `clientId`, `credentialsRef` and every verifier column are DELIBERATELY
 * absent: identity and credential material are not editable through the admin
 * surface. A new secret comes from `POST :id/rotate`, never from a PATCH.
 */
export class UpdateServiceAccountRequest {
  @ApiPropertyOptional({ description: 'Human-readable name' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({ description: 'What this account is for' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'The svc:* scopes this account may exercise', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @Validate(ValidServiceAccountScopesConstraint)
  scopes?: string[];

  @ApiPropertyOptional({ description: 'PLATFORM accounts only: working tenants this account may act on', type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  allowedTenantIds?: string[];

  @ApiPropertyOptional({ description: 'Source-IP allow-list', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedIps?: string[];

  @ApiPropertyOptional({ description: 'Grant/revoke SUPER_ADMIN for this machine principal' })
  @IsOptional()
  @IsBoolean()
  superAdmin?: boolean;

  @ApiPropertyOptional({ description: 'Access-token lifetime in seconds (60…3600)' })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  tokenTtlSeconds?: number;
}
