/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TenantFrontendConfigEntity, ITenantFrontendConfigEntity } from '../../../entities';

export interface CreateTenantFrontendConfigProps extends BaseEntityFactoryCreateProps {
  asrModel?: ITenantFrontendConfigEntity['asrModel'];
  noiseCancel?: ITenantFrontendConfigEntity['noiseCancel'];
  vad?: ITenantFrontendConfigEntity['vad'];
  voiceEnrollment?: ITenantFrontendConfigEntity['voiceEnrollment'];
  diarization?: ITenantFrontendConfigEntity['diarization'];
  configJson?: ITenantFrontendConfigEntity['configJson'];
  tenantId: ITenantFrontendConfigEntity['tenantId'];

  createdAt?: ITenantFrontendConfigEntity['createdAt'];
  updatedAt?: ITenantFrontendConfigEntity['updatedAt'];
  createdBy?: ITenantFrontendConfigEntity['createdBy'];
  updatedBy?: ITenantFrontendConfigEntity['updatedBy'];
}

export class TenantFrontendConfigFactory {
  static CreateTenantFrontendConfig(props: CreateTenantFrontendConfigProps): TenantFrontendConfigEntity {
    const id = generateId();
    const now = new Date();

    return new TenantFrontendConfigEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      asrModel: props.asrModel ?? null,
      noiseCancel: props.noiseCancel ?? false,
      vad: props.vad ?? false,
      voiceEnrollment: props.voiceEnrollment ?? false,
      diarization: props.diarization ?? false,
      configJson: props.configJson ?? null,
    });
  }
}
