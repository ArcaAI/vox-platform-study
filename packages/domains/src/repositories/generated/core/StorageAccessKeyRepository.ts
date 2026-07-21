import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { StorageAccessKeyEntityMapper } from '../../../mappers';
import { StorageAccessKeyEntity } from '../../../entities';
import { StorageAccessKey } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceStatusType } from '../../../enums';

@Injectable()
export class StorageAccessKeyRepository extends Repository<StorageAccessKeyEntity, StorageAccessKey> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'storageAccessKey', StorageAccessKeyEntityMapper.getInstance());
  }

  async findAllByTenant(tenantId: string): Promise<StorageAccessKeyEntity[]> {
    return this.findAll({
      filters: {
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      sort: [{ createdAt: 'desc' }],
    });
  }

  async findByAccessKeyId(accessKeyId: string): Promise<StorageAccessKeyEntity | null> {
    try {
      return await this.findFirst({
        filters: {
          accessKeyId,
          resourceStatus: ResourceStatusType.ENABLED,
        },
      });
    } catch {
      return null;
    }
  }

  async findActiveByTenant(tenantId: string): Promise<StorageAccessKeyEntity[]> {
    // Push the expiry predicate into the query rather than
    // fetching every ENABLED key and dropping expired ones in memory:
    //   enabled AND (expiresAt IS NULL OR expiresAt > now())
    return this.findAll({
      filters: {
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
  }
}
