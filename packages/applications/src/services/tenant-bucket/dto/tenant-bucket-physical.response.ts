import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One row of the "All tenants" storage-browser listing (TASK-932 Lane T) —
 * every registered `TenantBucket` row across every tenant, MERGED with the
 * physical bucket list from the storage provider (`IS3Service.listAllBuckets`).
 * Restricted to an unscoped SUPER_ADMIN (no working tenant); see
 * `TenantBucketService.listBucketsCrossTenantWithPhysical`.
 */
export class TenantBucketPhysicalResponse {
  @ApiProperty({ description: 'Physical bucket name' })
  name: string;

  @ApiPropertyOptional({ description: 'Bucket creation date (TenantBucket row for registered buckets, provider timestamp otherwise)' })
  creationDate?: string;

  @ApiPropertyOptional({ description: 'Owning tenant ID (null for an unregistered physical bucket)', nullable: true })
  tenantId?: string | null;

  @ApiPropertyOptional({ description: 'Owning tenant name (null for an unregistered physical bucket)', nullable: true })
  tenantName?: string | null;

  @ApiProperty({ description: 'Whether a TenantBucket row exists for this physical bucket name' })
  registered: boolean;

  @ApiProperty({ description: 'True when a registered TenantBucket row has no matching physical bucket in the provider' })
  physicalMissing: boolean;

  /**
   * A platform bucket is never `registered` and can never become registered —
   * the console renders it as "Platform" rather than "Unregistered" so it does
   * not advertise an adoption that `adoptPhysicalBucket` would reject.
   */
  @ApiProperty({ description: 'True for a platform-owned bucket (weights, MLflow artifacts, claim check, backups) that can never be tenant-owned' })
  platform: boolean;
}
