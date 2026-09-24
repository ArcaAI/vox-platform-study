/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ModelResidencyPolicyEntity, IModelResidencyPolicyEntity } from '../../../entities';
import { ModelResidencyClass } from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateModelResidencyPolicyProps extends BaseEntityFactoryCreateProps {
  tenantId: IModelResidencyPolicyEntity['tenantId'];
  aiModelId: IModelResidencyPolicyEntity['aiModelId'];
  service: IModelResidencyPolicyEntity['service'];
  class?: IModelResidencyPolicyEntity['class'];
  idleTtlSeconds?: IModelResidencyPolicyEntity['idleTtlSeconds'];
  priority?: IModelResidencyPolicyEntity['priority'];
  maxInstances?: IModelResidencyPolicyEntity['maxInstances'];
  preferredDevice?: IModelResidencyPolicyEntity['preferredDevice'];

  createdAt?: IModelResidencyPolicyEntity['createdAt'];
  updatedAt?: IModelResidencyPolicyEntity['updatedAt'];
  createdBy?: IModelResidencyPolicyEntity['createdBy'];
  updatedBy?: IModelResidencyPolicyEntity['updatedBy'];
}

export class ModelResidencyPolicyFactory {
  static CreateModelResidencyPolicy(props: CreateModelResidencyPolicyProps): ModelResidencyPolicyEntity {
    const id = generateId();
    const now = new Date();

    return new ModelResidencyPolicyEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      aiModelId: props.aiModelId,
      service: props.service,

      // Defaults MIRROR the Prisma column defaults so an entity built here
      // and a row read back from the database agree.
      class: props.class ?? ModelResidencyClass.ON_DEMAND,
      idleTtlSeconds: props.idleTtlSeconds ?? null,
      priority: props.priority ?? 0,
      maxInstances: props.maxInstances ?? 1,
      preferredDevice: props.preferredDevice ?? null,
    });
  }
}
