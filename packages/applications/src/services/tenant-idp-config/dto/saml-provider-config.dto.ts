import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, IsUrl, MaxLength, ValidateNested } from 'class-validator';
import { ClaimMappingsDto } from './oidc-provider-config.dto';

/**
 * TASK-499 — non-secret SAML config, persisted verbatim into
 * `TenantIdentityProvider.config` (Json, no migration — D5). SAML's `NameID`
 * maps to `FederatedIdentity.subject` the same way OIDC's `sub` does;
 * `attributeMappings` reuses the OIDC `ClaimMappingsDto` shape
 * (email/username/name/groups) since `FederatedAuthService.resolveOrProvisionUser`
 * reads both through identical `claims[key]` lookups. `spCertificatePem` is
 * SERVER-GENERATED (`generateSamlSpKeyPair`, D5) — any value supplied on
 * create/update is ignored by the service. `wantAssertionsSigned` is
 * deliberately NOT a field here: D4/§6 makes it non-negotiable (hardcoded
 * `true` in `IdpResolverService.buildSamlClient`), not a tenant-admin knob.
 */
export class SamlProviderConfigDto {
  @ApiProperty({ description: "IdP entityID (Issuer)", example: 'https://adfs.acme.com/adfs/services/trust' })
  @IsString()
  @MaxLength(2048)
  idpEntityId!: string;

  @ApiProperty({ description: 'IdP SSO (AuthnRequest destination) URL', example: 'https://adfs.acme.com/adfs/ls/' })
  @IsUrl({ require_tld: false })
  idpSsoUrl!: string;

  @ApiProperty({ description: 'Pinned IdP signing certificate (PEM) — assertions are verified against this, never against unpinned metadata' })
  @IsString()
  idpSigningCert!: string;

  @ApiProperty({ description: "This SP's own entityID (Audience) — registered with the IdP", example: 'https://api.hope.dev/saml/acme' })
  @IsString()
  @MaxLength(2048)
  spEntityId!: string;

  @ApiPropertyOptional({
    description: 'NameID format requested in the AuthnRequest',
    example: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  })
  @IsOptional()
  @IsString()
  nameIdFormat?: string;

  @ApiPropertyOptional({ description: 'Sign outgoing AuthnRequests with the sealed SP private key', default: true })
  @IsOptional()
  @IsBoolean()
  signAuthnRequests?: boolean;

  @ApiPropertyOptional({ description: 'Server-generated SP certificate (PEM) — read-only; ignored if supplied on create/update' })
  @IsOptional()
  @IsString()
  spCertificatePem?: string;

  @ApiPropertyOptional({ description: 'SAML attribute → HOPE field mapping (same shape as OIDC claim mappings)' })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ClaimMappingsDto)
  attributeMappings?: ClaimMappingsDto;

  @ApiPropertyOptional({
    description: 'IdP group attribute value → HOPE Role.externalName. GLOBAL_ADMIN is never assignable via this map.',
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
      'Directory API to pull users/groups from for admin-triggered pre-provisioning. Credentials for it are sealed separately in directoryCredentialsRef.',
    enum: ['ms-graph', 'google-directory'],
  })
  @IsOptional()
  @IsIn(['ms-graph', 'google-directory'])
  directoryProvider?: 'ms-graph' | 'google-directory';
}
