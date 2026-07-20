import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-524 — masked read view of one (tenant, provider) connection row.
 *
 * THIS CLASS NEVER CARRIES THE KEY. `encryptedApiKey` is deliberately absent
 * from the shape; presence of key material is reported as the `hasKey` boolean
 * only, mirroring the `TtsCredentialResponse` precedent (TASK-496). There is no
 * reveal route for provider keys.
 */
export class AiProviderConnectionResponse {
  @ApiProperty({ description: 'Owning tenant. The reserved SYSTEM tenant row is the platform default.' })
  tenantId!: string;

  @ApiProperty({ description: 'Serving provider identifier.', example: 'azure' })
  provider!: string;

  @ApiProperty({ description: 'Base URL of the serving endpoint.', nullable: true })
  baseUrl!: string | null;

  @ApiProperty({ description: 'Region identifier (bedrock).', nullable: true })
  region!: string | null;

  @ApiProperty({ description: 'API version (azure).', nullable: true })
  apiVersion!: string | null;

  @ApiProperty({ description: 'Deployment name (azure).', nullable: true })
  deploymentName!: string | null;

  @ApiProperty({
    description: 'Whether key material is stored. The key itself is never returned by any endpoint.',
  })
  hasKey!: boolean;

  @ApiProperty({ description: 'Vault-Transit key version backing the stored ciphertext.', nullable: true })
  keyVersion!: number | null;

  @ApiProperty({ description: 'Whether this connection participates in resolution.' })
  enabled!: boolean;

  @ApiProperty({ description: 'Provider-specific extras.', nullable: true, type: Object })
  extraJson!: Record<string, unknown> | null;

  @ApiProperty({ description: 'Row version for optimistic concurrency. 0 when no row exists yet.' })
  version!: number;

  @ApiPropertyOptional({ description: 'Last update timestamp (ISO 8601).' })
  updatedAt?: string;
}
