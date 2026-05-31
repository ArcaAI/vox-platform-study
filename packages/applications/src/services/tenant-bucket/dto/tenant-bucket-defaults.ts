import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { TenantBucketResponse } from './tenant-bucket.response';

/**
 * Tenant-admin request to (re)assign which bucket serves each logical purpose.
 * Every field is optional; only the provided purposes are reassigned. Setting a
 * bucket as the default for a purpose clears that purpose from its previous
 * holder (which reverts to CUSTOM).
 */
export class SetTenantBucketDefaultsRequest {
  @ApiPropertyOptional({ description: 'Bucket id to use as the default AUDIO bucket' })
  @IsOptional()
  @IsString()
  audioBucketId?: string;

  @ApiPropertyOptional({ description: 'Bucket id to use as the default ATTACHMENTS bucket' })
  @IsOptional()
  @IsString()
  attachmentsBucketId?: string;

  @ApiPropertyOptional({ description: 'Bucket id to use as the default MISC bucket' })
  @IsOptional()
  @IsString()
  miscBucketId?: string;
}

/** The tenant's current default bucket for each logical purpose (null when unset). */
export class TenantBucketDefaultsResponse {
  @ApiPropertyOptional({ type: TenantBucketResponse, nullable: true })
  audio: TenantBucketResponse | null;

  @ApiPropertyOptional({ type: TenantBucketResponse, nullable: true })
  attachments: TenantBucketResponse | null;

  @ApiPropertyOptional({ type: TenantBucketResponse, nullable: true })
  misc: TenantBucketResponse | null;
}
