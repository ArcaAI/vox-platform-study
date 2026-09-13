import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TenantBucketType, TenantBucketPurpose, ResourceStatusType } from '@arcaai/domains';

export class TenantBucketResponse {
  @ApiProperty({ description: 'Bucket ID' })
  id: string;

  @ApiProperty({ description: 'Tenant ID' })
  tenantId: string;

  @ApiProperty({ description: 'Physical S3 bucket name' })
  name: string;

  @ApiProperty({ description: 'Logical bucket slug', example: 'audio_recordings' })
  slug: string;

  @ApiPropertyOptional({ description: 'Bucket description' })
  description?: string;

  @ApiProperty({ description: 'Bucket type', enum: TenantBucketType })
  bucketType: TenantBucketType;

  @ApiProperty({ description: 'Logical purpose (drives default bucket resolution)', enum: TenantBucketPurpose })
  purpose: TenantBucketPurpose;

  @ApiProperty({ description: 'Path pattern for file organization' })
  pathPattern: string;

  @ApiProperty({ description: 'Whether this is a system bucket' })
  isSystemBucket: boolean;

  @ApiProperty({
    description:
      "TASK-967 — a PLATFORM bucket (model weights, MLflow artifacts, backups, the workflow claim check, the global STT audio pair, the legacy media buckets). Owned by the SYSTEM tenant and deletable only by a platform administrator. Derived from the bucket name, so the console never has to classify one itself — and can tell it apart from the SYSTEM tenant's own provisioned buckets, which look identical otherwise.",
  })
  platform: boolean;

  // Surface the quota column so the tenant-detail Stores
  // surface can render per-bucket quota. BigInt → number (bucket quotas stay
  // far below Number.MAX_SAFE_INTEGER); null = unlimited.
  @ApiPropertyOptional({ description: 'Storage quota in bytes (null = unlimited)', nullable: true, example: 10737418240 })
  quotaBytes?: number | null;

  @ApiPropertyOptional({ description: 'Resource status', enum: ResourceStatusType })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: string;
}
