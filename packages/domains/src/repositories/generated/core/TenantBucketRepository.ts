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
   * Platform-wide bucket listing for unscoped elevated sessions.
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
   * The configured storage quota for the platform consumption roll-up
   * ("storage quota"): per tenant the MAX of its buckets' `quotaBytes`, summed
   * across tenants. MAX, not SUM (TASK-1025 G3): the plan quota is ONE
   * tenant-wide ceiling stamped on BOTH system buckets, so summing rows would
   * double it. `tenantId = null` means platform-wide (no tenant filter).
   * Returns `null` when no bucket has a quota configured — the caller owns the
   * null-vs-Number presentation.
   */
  async sumConfiguredQuotaBytes(tenantId: string | null): Promise<bigint | null> {
    const groups: Array<{ _max: { quotaBytes: bigint | null } }> = await (this as any).db.groupBy({
      by: ['tenantId'],
      _max: { quotaBytes: true },
      where: { ...(tenantId ? { tenantId } : {}), quotaBytes: { not: null } },
    });
    if (groups.length === 0) return null;
    return groups.reduce((total, group) => total + (group._max.quotaBytes ?? 0n), 0n);
  }
}
