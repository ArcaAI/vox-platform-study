import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageProviderType, StorageTopologyType } from '@arcaai/domains';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Upsert a tenant's storage configuration (TASK-318 / R5).
 *
 * - `bucketId` omitted/null → the tenant-wide default config.
 * - `bucketId` set → a per-bucket override (takes precedence over the default).
 *
 * `topology=SHARED` defers to the platform/global storage configuration; cloud
 * fields and `credentialsRef` are ignored. `topology=DEDICATED` requires
 * `credentialsRef` (a SecretsService key — never the raw secret value) so the
 * backend can resolve the tenant's own S3/Azure credentials.
 */
export class UpsertTenantStorageConfigRequest {
  @ApiPropertyOptional({
    description: 'Per-bucket override target. Omit/null for the tenant-wide default.',
  })
  @IsOptional()
  @IsString()
  bucketId?: string | null;

  @ApiProperty({ description: 'Storage backend', enum: StorageProviderType })
  @IsEnum(StorageProviderType)
  provider: StorageProviderType;

  @ApiPropertyOptional({
    description: 'SHARED defers to the global config; DEDICATED uses tenant-owned credentials.',
    enum: StorageTopologyType,
    default: StorageTopologyType.SHARED,
  })
  @IsOptional()
  @IsEnum(StorageTopologyType)
  topology?: StorageTopologyType;

  @ApiPropertyOptional({ description: 'S3/MinIO endpoint URL (omit for real AWS S3)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  endpoint?: string | null;

  @ApiPropertyOptional({ description: 'S3 region', example: 'us-east-1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string | null;

  @ApiPropertyOptional({ description: 'Force path-style URLs (required for MinIO)' })
  @IsOptional()
  @IsBoolean()
  forcePathStyle?: boolean | null;

  @ApiPropertyOptional({ description: 'Azure storage account name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  accountName?: string | null;

  @ApiPropertyOptional({ description: 'Azure endpoint suffix', example: 'core.windows.net' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  endpointSuffix?: string | null;

  @ApiPropertyOptional({ description: 'Optional prefix applied to physical bucket/container names' })
  @IsOptional()
  @IsString()
  @MaxLength(63)
  containerPrefix?: string | null;

  @ApiPropertyOptional({
    description: 'SecretsService key holding the provider credentials JSON (DEDICATED only). Never the secret value itself.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  credentialsRef?: string | null;
}
