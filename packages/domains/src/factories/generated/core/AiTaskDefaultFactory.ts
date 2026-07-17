/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiTaskDefaultEntity, IAiTaskDefaultEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAiTaskDefaultProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiTaskDefaultEntity['tenantId'];
  taskKey: IAiTaskDefaultEntity['taskKey'];
  modelSlug: IAiTaskDefaultEntity['modelSlug'];
  configJson?: IAiTaskDefaultEntity['configJson'];

  createdAt?: IAiTaskDefaultEntity['createdAt'];
  updatedAt?: IAiTaskDefaultEntity['updatedAt'];
  createdBy?: IAiTaskDefaultEntity['createdBy'];
  updatedBy?: IAiTaskDefaultEntity['updatedBy'];
}

export class AiTaskDefaultFactory {
  static CreateAiTaskDefault(props: CreateAiTaskDefaultProps): AiTaskDefaultEntity {
    const id = generateId();
    const now = new Date();

    return new AiTaskDefaultEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      taskKey: props.taskKey,
      modelSlug: props.modelSlug,
      configJson: props.configJson ?? null,
    });
  }
}
