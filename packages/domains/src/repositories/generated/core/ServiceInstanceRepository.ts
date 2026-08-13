import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { ServiceInstanceEntity } from '../../../entities';
import { ServiceInstanceEntityMapper } from '../../../mappers';
import { ServiceInstance } from '../../../models';

/**
 * Heartbeated runtime-observation repository — one row per
 * (serviceName, environment, instanceId), enforced by
 * `ServiceInstance_service_env_instance_unique`. Always the SYSTEM tenant.
 */
@Injectable()
export class ServiceInstanceRepository extends Repository<ServiceInstanceEntity, ServiceInstance> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'serviceInstance', ServiceInstanceEntityMapper.getInstance());
  }
}
