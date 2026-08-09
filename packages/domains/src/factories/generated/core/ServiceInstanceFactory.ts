import { BaseEntityFactoryCreateProps } from '../../../common';
import { IServiceInstanceEntity, ServiceInstanceEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateServiceInstanceProps extends BaseEntityFactoryCreateProps {
  tenantId: IServiceInstanceEntity['tenantId'];
  releaseId: IServiceInstanceEntity['releaseId'];
  serviceName: IServiceInstanceEntity['serviceName'];
  environment: IServiceInstanceEntity['environment'];
  instanceId: IServiceInstanceEntity['instanceId'];
  startedAt: IServiceInstanceEntity['startedAt'];
  lastSeenAt?: IServiceInstanceEntity['lastSeenAt'];

  createdAt?: IServiceInstanceEntity['createdAt'];
  updatedAt?: IServiceInstanceEntity['updatedAt'];
  createdBy?: IServiceInstanceEntity['createdBy'];
  updatedBy?: IServiceInstanceEntity['updatedBy'];
}

export class ServiceInstanceFactory {
  static CreateServiceInstance(props: CreateServiceInstanceProps): ServiceInstanceEntity {
    const id = generateId();
    const now = new Date();

    return new ServiceInstanceEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      releaseId: props.releaseId,
      serviceName: props.serviceName,
      environment: props.environment,
      instanceId: props.instanceId,
      startedAt: props.startedAt,
      lastSeenAt: props.lastSeenAt || now,
    });
  }
}
