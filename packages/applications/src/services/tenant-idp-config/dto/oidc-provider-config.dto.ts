import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';

/**
 * TASK-498 — non-secret OIDC config, persisted verbatim into
 * `TenantIdentityProvider.config` (Json). `defaultRoleId`/`defaultDepartmentId`
 * are loose refs (validated for shape only — the service resolves them against
 * the configuring tenant). `groupToRoleMap` maps an IdP group claim value to a
 * HOPE `Role.externalName` (D5/§3.D); `GLOBAL_ADMIN` is never assignable via
 * this map (enforced by `FederatedAuthService`, not the DTO).
 */
export class ClaimMappingsDto {
  @ApiPropertyOptional({ description: 'ID-token/userinfo claim carrying the email address', example: 'email' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ description: 'ID-token/userinfo claim carrying the username', example: 'preferred_username' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: 'ID-token/userinfo claim carrying the display name', example: 'name' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'ID-token/userinfo claim carrying group membership', example: 'groups' })
  @IsOptional()
  @IsString()
  groups?: string;
}

export class OidcProviderConfigDto {
  @ApiProperty({ description: 'OIDC issuer / discovery base URL', example: 'https://acme.okta.com' })
  @IsUrl({ require_tld: false })
  issuer!: string;

  @ApiProperty({ description: 'OIDC client id registered with the IdP' })
  @IsString()
  @MaxLength(255)
  clientId!: string;

  @ApiPropertyOptional({ description: 'Requested scopes', type: [String], default: ['openid', 'profile', 'email'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  scopes?: string[];

  @ApiPropertyOptional({ description: 'ID-token/userinfo claim → HOPE field mapping' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ClaimMappingsDto)
  claimMappings?: ClaimMappingsDto;

  @ApiPropertyOptional({
    description: 'IdP group claim value → HOPE Role.externalName. GLOBAL_ADMIN is never assignable via this map.',
    type: Object,
    example: { 'acme-clinicians': 'DOCTOR' },
  })
  @IsOptional()
  @IsObject()
  groupToRoleMap?: Record<string, string>;

  @ApiProperty({ description: 'Role id assigned to a JIT-provisioned user with no group-map match' })
  @IsString()
  defaultRoleId!: string;

  @ApiProperty({ description: 'Department id assigned to a JIT-provisioned user with no group-map match' })
  @IsString()
  defaultDepartmentId!: string;

  @ApiPropertyOptional({ description: 'Provision a HOPE user on first successful IdP login', default: true })
  @IsOptional()
  @IsBoolean()
  jitEnabled?: boolean;

  @ApiPropertyOptional({ description: 'Require SSO for non-admins (local break-glass login stays for admins)', default: false })
  @IsOptional()
  @IsBoolean()
  enforceSsoOnly?: boolean;

  @ApiPropertyOptional({
    description:
      'Directory API to pull users/groups from for admin-triggered pre-provisioning (P3). Credentials for it are sealed separately in directoryCredentialsRef.',
    enum: ['ms-graph', 'google-directory'],
  })
  @IsOptional()
  @IsIn(['ms-graph', 'google-directory'])
  directoryProvider?: 'ms-graph' | 'google-directory';
}
