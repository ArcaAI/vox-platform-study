import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TenantStorageConfigEntityMapper } from '../../../mappers';
import { TenantStorageConfigEntity } from '../../../entities';
import { TenantStorageConfig } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class TenantStorageConfigRepository extends Repository<TenantStorageConfigEntity, TenantStorageConfig> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'tenantStorageConfig', TenantStorageConfigEntityMapper.getInstance());
  }

  async findAllByTenant(tenantId: string, options?: { includeDisabled?: boolean }): Promise<TenantStorageConfigEntity[]> {
    const filters: Record<string, unknown> = { tenantId };
    if (!options?.includeDisabled) {
      filters.resourceStatus = ResourceStatusType.ENABLED;
    }
    return this.findAll({
      filters,
      sort: [{ createdAt: 'asc' }],
    });
  }

  /** The tenant-wide default config (bucketId IS NULL), if any. */
  async findTenantDefault(tenantId: string): Promise<TenantStorageConfigEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          bucketId: null,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  /** The per-bucket override config for a specific bucket, if any. */
  async findForBucket(tenantId: string, bucketId: string): Promise<TenantStorageConfigEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          tenantId,
          bucketId,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }
}
