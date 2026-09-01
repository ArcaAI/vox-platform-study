/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantTtsConfigEntity, TenantTtsConfigEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantTtsConfigProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantTtsConfigEntity['tenantId'];
  defaultVoiceEn?: ITenantTtsConfigEntity['defaultVoiceEn'];
  defaultVoiceMl?: ITenantTtsConfigEntity['defaultVoiceMl'];
  routingEn?: ITenantTtsConfigEntity['routingEn'];
  routingMl?: ITenantTtsConfigEntity['routingMl'];
  allowedProviders?: ITenantTtsConfigEntity['allowedProviders'];
  defaultFormat?: ITenantTtsConfigEntity['defaultFormat'];
  defaultSpeed?: ITenantTtsConfigEntity['defaultSpeed'];
  sampleRate?: ITenantTtsConfigEntity['sampleRate'];
  maxInputChars?: ITenantTtsConfigEntity['maxInputChars'];
  sarvamPublicApiAllowed?: ITenantTtsConfigEntity['sarvamPublicApiAllowed'];
  configJson?: ITenantTtsConfigEntity['configJson'];
  // TASK-843 — constant for the model; the entity supplies TEXT_TO_SPEECH when
  // omitted, matching the DB default.
  taskKind?: ITenantTtsConfigEntity['taskKind'];

  createdAt?: ITenantTtsConfigEntity['createdAt'];
  updatedAt?: ITenantTtsConfigEntity['updatedAt'];
  createdBy?: ITenantTtsConfigEntity['createdBy'];
  updatedBy?: ITenantTtsConfigEntity['updatedBy'];
}

export class TenantTtsConfigFactory {
  static CreateTenantTtsConfig(props: CreateTenantTtsConfigProps): TenantTtsConfigEntity {
    const id = generateId();
    const now = new Date();

    return new TenantTtsConfigEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      defaultVoiceEn: props.defaultVoiceEn ?? null,
      defaultVoiceMl: props.defaultVoiceMl ?? null,
      routingEn: props.routingEn ?? [],
      routingMl: props.routingMl ?? [],
      allowedProviders: props.allowedProviders ?? [],
      defaultFormat: props.defaultFormat ?? null,
      defaultSpeed: props.defaultSpeed ?? null,
      sampleRate: props.sampleRate ?? null,
      maxInputChars: props.maxInputChars ?? null,
      sarvamPublicApiAllowed: props.sarvamPublicApiAllowed ?? false,
      configJson: props.configJson ?? null,
      taskKind: props.taskKind,
    });
  }
}
