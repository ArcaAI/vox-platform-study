import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The read shape. Carries NO credential material of any kind — not the secret,
 * not a verifier, not even the Vault path's contents. `credentialsRef` is a
 * PATH and is surfaced so an operator can find where the secret was provisioned.
 */
export class ServiceAccountResponse {
  @ApiProperty() id!: string;
  @ApiProperty() tenantId!: string;
  @ApiProperty() clientId!: string;
  @ApiProperty() displayName!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiPropertyOptional({ type: [String] }) allowedTenantIds?: string[] | null;
  @ApiPropertyOptional({ type: [String] }) allowedIps?: string[] | null;
  @ApiProperty() superAdmin!: boolean;
  @ApiProperty() tokenTtlSeconds!: number;
  @ApiProperty({ description: 'Vault path where the current secret is provisioned. Never the secret itself.' })
  credentialsRef!: string;
  @ApiProperty({ description: 'True while a rotation overlap window is still open' })
  rotationOverlapActive!: boolean;
  @ApiPropertyOptional() previousCredentialExpiresAt?: string | null;
  @ApiPropertyOptional() rotatedAt?: string | null;
  @ApiPropertyOptional() lastUsedAt?: string | null;
  @ApiProperty() resourceStatus!: string;
  @ApiProperty() version!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

/**
 * The ONE response that carries the plaintext secret, returned by create and
 * rotate and by nothing else. Never persisted in a readable form and never
 * retrievable again from this API.
 */
export class ServiceAccountSecretResponse extends ServiceAccountResponse {
  @ApiProperty({ description: 'The client secret. Shown EXACTLY ONCE — it is not recoverable from this API afterwards.' })
  clientSecret!: string;

  @ApiProperty({ description: 'Where to provision this secret so consumers can retrieve it (the Vault path recorded on the account).' })
  provisionAt!: string;
}

export class ServiceAccountTokenResponse {
  @ApiProperty({ description: 'Opaque bearer token. Server-validated; never a JWT.' })
  accessToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty({ description: 'Seconds until expiry' }) expiresIn!: number;
  @ApiProperty({ type: [String] }) scopes!: string[];
  @ApiProperty() tenantId!: string;
}
