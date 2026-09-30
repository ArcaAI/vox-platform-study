import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';

import { TenantBucketRepository } from '@arcaai/domains';
import { TENANT_BUCKET_INACCESSIBLE_STATUSES } from '../../tenant-bucket/tenant-bucket-lifecycle.constants';

/**
 * TASK-1025 — the tenant-bucket checks that must hold on EVERY object
 * operation, applied once, at {@link BlobStorageService}: the one chokepoint the
 * storage controller, the transcription upload path and the tenant-bucket
 * service all go through by bucket NAME.
 *
 * G2 (owner decision OD-2): a bucket retained after its tenant was deleted
 * (ARCHIVED) or one the purge job is emptying (SUSPENDED) is refused with a
 * 404 — the objects are kept, but nothing reaches them.
 *
 * Not cached on purpose: "access is cut the moment the tenant is deleted" must
 * hold on every replica at once, and the lookup is a single indexed read of a
 * globally unique name.
 */
@Injectable()
export class TenantBucketStorageGate {
  private readonly logger = new Logger(TenantBucketStorageGate.name);

  constructor(@Optional() private readonly bucketRepo?: TenantBucketRepository) {}

  /** Refuse an object operation on a bucket that is retained or being purged. */
  async assertAccessible(bucketName: string): Promise<void> {
    const row = await this.lookup(bucketName);
    if (row?.resourceStatus && TENANT_BUCKET_INACCESSIBLE_STATUSES.has(row.resourceStatus)) {
      throw new NotFoundException(`Bucket ${bucketName} not found`);
    }
  }

  /**
   * The bucket's row in ANY live status. `TenantBucketRepository.findByName`
   * answers ENABLED rows only, so it would miss exactly the rows this gate
   * exists to refuse; the soft-delete extension still hides DELETED ones.
   *
   * A lookup FAILURE does not gate: the tenant-scope extension refuses a
   * tenant-scoped read from a context with no tenant and no platform role (a
   * background worker), and those paths predate this gate. It is logged — with
   * the bucket name only, never an object key.
   */
  private async lookup(bucketName: string): Promise<{ resourceStatus?: string | null; tenantId?: string } | null> {
    if (!this.bucketRepo) return null;
    try {
      const rows = await this.bucketRepo.findAll({ filters: { name: bucketName } });
      return rows[0] ?? null;
    } catch (error) {
      this.logger.warn({
        message: 'Tenant bucket lookup failed; object operation not gated',
        bucketName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
