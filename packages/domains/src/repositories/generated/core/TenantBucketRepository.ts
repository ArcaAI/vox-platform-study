import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TenantBucketEntityMapper } from '../../../mappers';
import { TenantBucketEntity } from '../../../entities';
import { TenantBucket } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType, TenantBucketPurpose, TenantBucketType } from '../../../enums';

@Injectable()
export class TenantBucketRepository extends Repository<TenantBucketEntity, TenantBucket> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantBucket', TenantBucketEntityMapper.getInstance());
  }

  async findAllByTenant(tenantId: string, options?: { includeDisabled?: boolean }): Promise<TenantBucketEntity[]> {
    const filters: Record<string, unknown> = { tenantId };
    if (!options?.includeDisabled) {
      filters.resourceStatus = ResourceStatusType.ENABLED;
    }
    return this.findAll({
      filters,
      sort: [{ slug: 'asc' }],
    });
  }

  /**
   * TASK-430 — platform-wide bucket listing for unscoped elevated sessions.
   * No tenant predicate: the tenant-scope $extends bypasses injection for
   * elevated callers, so this spans all tenants.
   */
  async findAllCrossTenant(options?: { includeDisabled?: boolean }): Promise<TenantBucketEntity[]> {
    const filters: Record<string, unknown> = {};
    if (!options?.includeDisabled) {
      filters.resourceStatus = ResourceStatusType.ENABLED;
    }
    return this.findAll({
      filters,
      sort: [{ tenantId: 'asc' }, { slug: 'asc' }],
    });
  }

  async findBySlug(tenantId: string, slug: string): Promise<TenantBucketEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          slug,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /**
   * Resolve the tenant's default bucket for a given purpose (AUDIO / ATTACHMENTS
   * / MISC). At most one non-CUSTOM bucket per purpose is expected; `findFirst`
   * with a stable sort keeps resolution deterministic if that invariant slips.
   */
  async findByPurpose(tenantId: string, purpose: TenantBucketPurpose): Promise<TenantBucketEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          purpose,
          resourceStatus: ResourceStatusType.ENABLED,
        },
        sort: [{ createdAt: 'asc' }],
      });
    } catch {
      return null;
    }
  }

  async findByName(name: string): Promise<TenantBucketEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          name,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  async findSystemBuckets(tenantId: string): Promise<TenantBucketEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        bucketType: TenantBucketType.SYSTEM,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ slug: 'asc' }],
    });
  }

  async findCustomBuckets(tenantId: string): Promise<TenantBucketEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        bucketType: TenantBucketType.CUSTOM,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ slug: 'asc' }],
    });
  }

  /**
   * TASK-414 — SUM(quotaBytes) over buckets that have a quota configured
   * (`quotaBytes IS NOT NULL`), for the platform consumption roll-up
   * (TASK-386 #18, "storage quota"). `tenantId = null` means platform-wide
   * (no tenant filter). Returns the raw nullable BigInt sum — the caller
   * owns the null-vs-Number presentation.
   */
  async sumConfiguredQuotaBytes(tenantId: string | null): Promise<bigint | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (this as any).db.aggregate({
      _sum: { quotaBytes: true },
      where: { ...(tenantId ? { tenantId } : {}), quotaBytes: { not: null } },
    });
    return result._sum.quotaBytes;
  }
}
