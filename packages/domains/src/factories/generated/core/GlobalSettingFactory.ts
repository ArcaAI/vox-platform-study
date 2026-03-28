/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { GlobalSettingEntity, IGlobalSettingEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateGlobalSettingProps extends BaseEntityFactoryCreateProps {
  name: IGlobalSettingEntity['name'];
  description?: IGlobalSettingEntity['description'];
  key: IGlobalSettingEntity['key'];
  defaultValue?: IGlobalSettingEntity['defaultValue'];
  value: IGlobalSettingEntity['value'];
  dataType: IGlobalSettingEntity['dataType'];
  namespace?: IGlobalSettingEntity['namespace'];
  tenantId?: IGlobalSettingEntity['tenantId'];
  Tenant?: IGlobalSettingEntity['Tenant'];
  tags?: IGlobalSettingEntity['tags'];
  Tags?: IGlobalSettingEntity['Tags'];

  createdAt?: IGlobalSettingEntity['createdAt'];
  updatedAt?: IGlobalSettingEntity['updatedAt'];
  createdBy?: IGlobalSettingEntity['createdBy'];
  updatedBy?: IGlobalSettingEntity['updatedBy'];
}

export class GlobalSettingFactory {
  static CreateGlobalSetting(props: CreateGlobalSettingProps): GlobalSettingEntity {
    const id = generateId();
    const now = new Date();

    return new GlobalSettingEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      description: props.description ?? '',
      key: props.key,
      defaultValue: props.defaultValue ?? '',
      value: props.value,
      dataType: props.dataType,
      namespace: props.namespace ?? '',
      tenantId: props.tenantId ?? '',
      Tenant: props.Tenant ?? null,
      tags: props.tags ?? [],
      Tags: props.Tags ?? [],
    });
  }
}
