import { ApiProperty } from '@nestjs/swagger';

/**
 * Result of removing a single object from a tenant bucket via the storage
 * provider. There is no DB row for an individual object, so this
 * is purely the provider-side delete outcome.
 */
export class DeleteTenantBucketObjectResponse {
  @ApiProperty({ description: 'The object key that was removed' })
  key: string;

  @ApiProperty({ description: 'Whether the object was removed from the provider' })
  deleted: boolean;
}
