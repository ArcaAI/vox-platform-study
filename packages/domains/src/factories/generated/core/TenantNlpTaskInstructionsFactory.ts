/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantNlpTaskInstructionsEntity, TenantNlpTaskInstructionsEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantNlpTaskInstructionsProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantNlpTaskInstructionsEntity['tenantId'];
  taskKey: ITenantNlpTaskInstructionsEntity['taskKey'];
  instructionsJson?: ITenantNlpTaskInstructionsEntity['instructionsJson'];

  createdAt?: ITenantNlpTaskInstructionsEntity['createdAt'];
  updatedAt?: ITenantNlpTaskInstructionsEntity['updatedAt'];
  createdBy?: ITenantNlpTaskInstructionsEntity['createdBy'];
  updatedBy?: ITenantNlpTaskInstructionsEntity['updatedBy'];
}

export class TenantNlpTaskInstructionsFactory {
  static CreateTenantNlpTaskInstructions(
    props: CreateTenantNlpTaskInstructionsProps,
  ): TenantNlpTaskInstructionsEntity {
    const id = generateId();
    const now = new Date();

    return new TenantNlpTaskInstructionsEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      taskKey: props.taskKey,
      instructionsJson: props.instructionsJson ?? null,
    });
  }
}
