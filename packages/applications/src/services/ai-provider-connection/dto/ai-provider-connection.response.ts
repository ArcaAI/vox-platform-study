import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ModelTaskType } from '@arcaai/domains';
import { CONNECTION_ENABLED_SEMANTICS, PROVIDER_SERVICES } from '../constants';

/**
 * One model DECLARED on this connection (TASK-890 §3.7a) — a projection of the
 * tenant-owned `AiModel` rows carrying `sourceConnectionId = <this row>`.
 *
 * Deliberately NARROW: the registry's storage identity and operator trail
 * (`bucketPrefix`, `createdBy`, `availability*`, …) are not a tenant's
 * business, and the declaration only ever set four facts in the first place.
 */
export class ConnectionModelResponse {
  @ApiProperty({ description: 'Registry row id — what an agent binds as `modelId`.' })
  id!: string;

  @ApiProperty({ description: 'Server-generated routing key, stable for the life of the row.' })
  slug!: string;

  @ApiProperty({ description: 'Display name shown in pickers.' })
  name!: string;

  @ApiProperty({ description: 'The provider-native id that goes on the wire.' })
  wireModelId!: string;

  @ApiProperty({ description: 'What this model does.', enum: ModelTaskType })
  taskType!: ModelTaskType;

  @ApiProperty({ description: 'Capability flags for authoring forms.', type: Object })
  capabilities!: { supportedGenerationParams?: string[]; supportsSsml?: boolean };
}

/**
 * Masked read view of one (tenant, provider) connection row.
 *
 * THIS CLASS NEVER CARRIES THE KEY. `encryptedApiKey` is deliberately absent
 * from the shape; presence of key material is reported as the `hasKey` boolean
 * only, mirroring the `TtsCredentialResponse` precedent. There is no
 * reveal route for provider keys.
 */
export class AiProviderConnectionResponse {
  @ApiProperty({ description: 'Owning tenant. The reserved SYSTEM tenant row is the platform default.' })
  tenantId!: string;

  @ApiProperty({ description: 'Capability the connection serves.', example: 'llm', enum: PROVIDER_SERVICES })
  service!: string;

  @ApiProperty({ description: 'Capability-scoped serving provider identifier.', example: 'azure' })
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

  @ApiProperty({ description: `Whether this connection participates in resolution. ${CONNECTION_ENABLED_SEMANTICS}` })
  enabled!: boolean;

  @ApiProperty({ description: 'Provider-specific extras.', nullable: true, type: Object })
  extraJson!: Record<string, unknown> | null;

  @ApiProperty({ description: 'Ceiling — simultaneous in-flight requests. Null = no opinion.', nullable: true })
  maxConcurrent!: number | null;

  @ApiProperty({ description: 'Ceiling — requests per minute. Null = no opinion.', nullable: true })
  rpmLimit!: number | null;

  @ApiProperty({ description: 'Ceiling — tokens (LLM) / characters (TTS) per minute. Null = no opinion.', nullable: true })
  tpmLimit!: number | null;

  @ApiProperty({ description: 'Ceiling — per-request timeout in seconds. Null = no opinion.', nullable: true })
  timeoutS!: number | null;

  @ApiProperty({ description: 'Row version for optimistic concurrency. 0 when no row exists yet.' })
  version!: number;

  @ApiPropertyOptional({ description: 'Last update timestamp (ISO 8601).' })
  updatedAt?: string;

  @ApiPropertyOptional({
    description:
      'Models DECLARED on this connection (TASK-890 §3.7a). Present on the single-row read and on the declaration ' +
      'response; absent from the list read, which does not join the registry. A SYSTEM row never carries any: platform ' +
      'models are declared in `/admin/ai-models`.',
    type: [ConnectionModelResponse],
  })
  models?: ConnectionModelResponse[];
}
