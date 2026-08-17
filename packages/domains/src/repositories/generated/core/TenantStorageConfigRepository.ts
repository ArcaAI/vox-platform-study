import { Injectable } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/database';

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

  /**
   * The PLATFORM-default config: the SYSTEM tenant's tenant-wide row
   * (`tenantId = SYSTEM_TENANT_ID`, `bucketId IS NULL`). This is the third step
   * of the resolution order documented on the Prisma model
   * (`bucket row → tenant default → SYSTEM default → env`); the row is
   * SUPER_ADMIN-managed and readable by every tenant because
   * `TenantStorageConfig` is a SYSTEM-shared READ model (writes are NOT widened).
   */
  async findSystemDefault(): Promise<TenantStorageConfigEntity | null> {
    return this.findTenantDefault(SYSTEM_TENANT_ID);
  }

  /**
   * Every ENABLED tenant-wide default row for a tenant. Exists so the
   * application layer can enforce the model's "at most one row with
   * `bucketId IS NULL` per tenant" invariant, which Postgres cannot express
   * (NULLs are distinct in a unique index).
   */
  async findAllTenantDefaults(tenantId: string): Promise<TenantStorageConfigEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        bucketId: null,
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });
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
