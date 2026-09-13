import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * The platform's own id GRAMMAR (8-4-4-4-12 hex), NOT `@IsUUID()`.
 *
 * `class-validator`'s `isUUID()` enforces an RFC-4122 version nibble, and the
 * platform's reserved tenant ids (SYSTEM `00000000-…`, the seeded customer
 * tenants under `50000000-…`) are hand-authored sentinels that carry none —
 * adopting a bucket into a seeded tenant would 400 on validation before ever
 * reaching the service. Same trap `create-sell-rate.request.ts` and
 * `open-consultation.request.ts` already document. The shape check still
 * earns its place: it refuses free text at the edge, before any tenant read.
 */
const PLATFORM_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Body of `POST /admin/tenants/storage/buckets/register` — adopt an existing
 * physical bucket into a tenant.
 *
 * `tenantId` is REQUIRED rather than inferred: the storage browser's "All
 * tenants" view that surfaces adoptable buckets is an unscoped platform admin
 * with no working tenant, so there is no ambient owner to fall back on.
 */
export class AdoptTenantBucketRequest {
  @ApiProperty({ description: 'Existing physical bucket name, exactly as the provider reports it', example: 'legacy-exports' })
  @IsString()
  @MaxLength(63)
  // S3 bucket-name grammar: lowercase alphanumerics, hyphens and dots, and no
  // leading/trailing separator. Deliberately stricter than the storage
  // controller's `..`/slash rejection — this value is matched against the
  // provider's own listing, never used to build a path.
  @Matches(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, {
    message: 'Bucket name must contain only lowercase letters, numbers, hyphens and dots, and cannot start or end with a separator',
  })
  name: string;

  @ApiProperty({ description: 'Tenant that will own the bucket' })
  @IsString()
  @Matches(PLATFORM_ID_PATTERN, { message: 'tenantId must be a platform id (8-4-4-4-12 hex)' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Bucket description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
