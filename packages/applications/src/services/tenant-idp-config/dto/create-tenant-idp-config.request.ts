import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDefined, IsIn, IsString, MaxLength, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { IdpProtocol } from '@arcaai/domains';
import { OidcProviderConfigDto } from './oidc-provider-config.dto';
import { SamlProviderConfigDto } from './saml-provider-config.dto';

/**
 * TASK-498 D1 — the data model is protocol-neutral (`IdpProtocol` ships both
 * OIDC and SAML); TASK-499 adds the SAML branch on this same shape.
 * `config`/`clientSecret` are required (via `@ValidateIf`) for OIDC;
 * `samlConfig` is required for SAML. The SP key pair for a SAML provider is
 * generated server-side (D5) — never supplied on create.
 */
export class CreateTenantIdpConfigRequest {
  @ApiProperty({ description: 'Identity provider protocol', enum: [IdpProtocol.OIDC, IdpProtocol.SAML] })
  @IsIn([IdpProtocol.OIDC, IdpProtocol.SAML])
  protocol!: IdpProtocol;

  @ApiProperty({ description: 'Tenant-admin-facing name, e.g. "Acme Okta"' })
  @IsString()
  @MaxLength(100)
  displayName!: string;

  @ApiPropertyOptional({ description: 'Non-secret OIDC config — required when protocol is OIDC' })
  @ValidateIf((o: CreateTenantIdpConfigRequest) => o.protocol === IdpProtocol.OIDC)
  @IsDefined()
  @ValidateNested()
  @Type(() => OidcProviderConfigDto)
  config?: OidcProviderConfigDto;

  @ApiPropertyOptional({ description: 'OIDC client secret — sealed with Vault Transit; never echoed back. Required when protocol is OIDC.' })
  @ValidateIf((o: CreateTenantIdpConfigRequest) => o.protocol === IdpProtocol.OIDC)
  @IsString()
  @MinLength(1)
  clientSecret?: string;

  @ApiPropertyOptional({ description: 'Non-secret SAML config — required when protocol is SAML' })
  @ValidateIf((o: CreateTenantIdpConfigRequest) => o.protocol === IdpProtocol.SAML)
  @IsDefined()
  @ValidateNested()
  @Type(() => SamlProviderConfigDto)
  samlConfig?: SamlProviderConfigDto;
}
