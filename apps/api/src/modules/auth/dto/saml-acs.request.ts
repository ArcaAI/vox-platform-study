import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';

/**
 * The SAML ACS POST body (HTTP-POST binding). `SAMLResponse` is
 * the base64-encoded XML the IdP posts back; `RelayState` is opaque
 * (single-use InResponseTo tracking is `RedisSamlCacheProvider`'s job, not
 * RelayState's — see `FederatedAuthService.buildSamlAuthnRequest`).
 */
export class SamlAcsRequest {
  @ApiProperty({ description: 'Base64-encoded SAMLResponse form field' })
  @IsString()
  @MinLength(1)
  SAMLResponse!: string;

  @ApiPropertyOptional({ description: 'Opaque RelayState echoed back by the IdP' })
  @IsOptional()
  @IsString()
  RelayState?: string;
}
