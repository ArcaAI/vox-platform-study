/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantSttConfigEntity, TenantSttConfigEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantSttConfigProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantSttConfigEntity['tenantId'];
  fallbackPipelineId?: ITenantSttConfigEntity['fallbackPipelineId'];
  autoSwitchEnabled?: ITenantSttConfigEntity['autoSwitchEnabled'];
  configJson?: ITenantSttConfigEntity['configJson'];
  // TASK-843 — constant for the model; the entity supplies SPEECH_TO_TEXT when
  // omitted, matching the DB default.
  taskKind?: ITenantSttConfigEntity['taskKind'];

  createdAt?: ITenantSttConfigEntity['createdAt'];
  updatedAt?: ITenantSttConfigEntity['updatedAt'];
  createdBy?: ITenantSttConfigEntity['createdBy'];
  updatedBy?: ITenantSttConfigEntity['updatedBy'];
}

export class TenantSttConfigFactory {
  static CreateTenantSttConfig(props: CreateTenantSttConfigProps): TenantSttConfigEntity {
    const id = generateId();
    const now = new Date();

    return new TenantSttConfigEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      fallbackPipelineId: props.fallbackPipelineId ?? null,
      autoSwitchEnabled: props.autoSwitchEnabled ?? true,
      configJson: props.configJson ?? null,
      taskKind: props.taskKind,
    });
  }
}
