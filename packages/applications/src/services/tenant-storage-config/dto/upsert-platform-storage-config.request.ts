import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageProviderType, StorageTopologyType } from '@arcaai/domains';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Create or update the PLATFORM-DEFAULT storage configuration — the
 * SYSTEM-tenant row (`tenantId = SYSTEM_TENANT_ID`, `bucketId = NULL`) that
 * every tenant falls back to when it has no row of its own.
 *
 * SUPER_ADMIN only (enforced imperatively in the service; the permission
 * decorator cannot express "super admin"). Written under optimistic
 * concurrency: `expectedVersion` comes from the `If-Match` header (`"0"`
 * creates the row).
 *
 * There is deliberately NO field for an access key or secret key. Credentials
 * live in Vault kv-v2 and are referenced by `credentialsRef`; putting them in a
 * DB column is banned by the platform's data-class rules.
 */
export class UpsertPlatformStorageConfigRequest {
  @ApiProperty({ description: 'Storage backend', enum: StorageProviderType })
  @IsEnum(StorageProviderType)
  provider: StorageProviderType;

  @ApiPropertyOptional({
    description: 'Topology of the platform default. SHARED is the norm; DEDICATED requires credentialsRef.',
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
    description: 'Vault kv-v2 path holding the credentials JSON (never the value itself).',
    example: 'platform/storage/minio',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  credentialsRef?: string | null;

  @ApiProperty({
    description: 'OCC token: the version read from the prior GET. `0` creates the row. Normally supplied via `If-Match`.',
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion: number;
}
