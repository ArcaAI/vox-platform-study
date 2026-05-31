import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType, StorageProviderType, StorageTopologyType } from '@arcaai/domains';

/**
 * Tenant storage configuration as returned to admin callers.
 *
 * Note: `credentialsRef` is only the SecretsService *key name*, never the
 * secret value — the raw credentials never leave the secrets manager.
 */
export class TenantStorageConfigResponse {
  @ApiProperty({ description: 'Config ID' })
  id: string;

  @ApiProperty({ description: 'Tenant ID' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Bucket this override targets; null = tenant-wide default' })
  bucketId?: string | null;

  @ApiProperty({ description: 'Storage backend', enum: StorageProviderType })
  provider: StorageProviderType;

  @ApiProperty({ description: 'Topology', enum: StorageTopologyType })
  topology: StorageTopologyType;

  @ApiPropertyOptional({ description: 'S3/MinIO endpoint URL' })
  endpoint?: string | null;

  @ApiPropertyOptional({ description: 'S3 region' })
  region?: string | null;

  @ApiPropertyOptional({ description: 'Force path-style URLs' })
  forcePathStyle?: boolean | null;

  @ApiPropertyOptional({ description: 'Azure storage account name' })
  accountName?: string | null;

  @ApiPropertyOptional({ description: 'Azure endpoint suffix' })
  endpointSuffix?: string | null;

  @ApiPropertyOptional({ description: 'Physical bucket/container name prefix' })
  containerPrefix?: string | null;

  @ApiPropertyOptional({ description: 'SecretsService key holding credentials (not the value)' })
  credentialsRef?: string | null;

  @ApiPropertyOptional({ description: 'Resource status', enum: ResourceStatusType })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;
}
