import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { ResourceSubscriptionEntityMapper } from '../../../mappers';
import { ResourceSubscriptionEntity } from '../../../entities';
import { ResourceSubscription } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ResourceType } from '../../../enums';
import { EntityId } from '../../../common';

@Injectable()
export class ResourceSubscriptionRepository extends Repository<ResourceSubscriptionEntity, ResourceSubscription> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'resourceSubscription', ResourceSubscriptionEntityMapper.getInstance(), undefined, ['resourceTypeName']);
  }

  public async findByResource(resourceTypeName: ResourceType, resourceId: EntityId): Promise<ResourceSubscriptionEntity> {
    return await this.findFirst({
      where: {
        resourceTypeName,
        resourceId,
      },
    });
  }
}
