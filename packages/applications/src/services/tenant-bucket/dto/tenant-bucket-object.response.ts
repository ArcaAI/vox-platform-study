import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single object within a tenant bucket as returned by the admin object-list
 * and object-upload routes. There is no DB row per object;
 * this is the provider-side object summary, shaped to match the data plane the
 * non-admin `/storage/buckets/:name/files` route returned previously.
 */
export class TenantBucketObjectResponse {
  @ApiProperty({ description: 'Object key/path from the bucket root' })
  key: string;

  @ApiProperty({ description: 'Object size in bytes' })
  size: number;

  @ApiPropertyOptional({ description: 'Last modified timestamp (ISO string)' })
  lastModified?: string;
}
