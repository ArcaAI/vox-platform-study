import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IdpProtocol, IdpStatus } from '@arcaai/domains';
import { OidcProviderConfigDto } from './oidc-provider-config.dto';
import { SamlProviderConfigDto } from './saml-provider-config.dto';

/** A tenant's configured external IdP row. Secrets are never included. */
export class TenantIdpConfigResponse {
  @ApiProperty({ description: 'Row id' })
  id!: string;

  @ApiProperty({ description: 'Owning tenant id' })
  tenantId!: string;

  @ApiProperty({ enum: IdpProtocol })
  protocol!: IdpProtocol;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ enum: IdpStatus, description: 'DRAFT until a successful test-connection; DISABLED is an explicit pause' })
  providerStatus!: IdpStatus;

  @ApiProperty({ description: 'Non-secret config — shape matches `protocol` (OIDC or SAML)', type: Object })
  config!: OidcProviderConfigDto | SamlProviderConfigDto;

  @ApiProperty({ description: 'Whether a client secret (OIDC) or SP private key (SAML) is currently sealed for this provider' })
  hasSecret!: boolean;

  @ApiProperty({ description: 'Whether a directory-API credential bundle (MS Graph / Google) is sealed for admin-triggered sync (P3)' })
  hasDirectoryCredentials!: boolean;

  @ApiPropertyOptional({ description: 'Resource status' })
  resourceStatus?: string;

  @ApiProperty({ description: 'OCC version' })
  version!: number;

  @ApiPropertyOptional({ description: 'Created timestamp (ISO)' })
  createdAt?: string;

  @ApiPropertyOptional({ description: 'Updated timestamp (ISO)' })
  updatedAt?: string;
}
