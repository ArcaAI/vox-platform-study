/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { UserSettingsEntity, IUserSettingsEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateUserSettingsProps extends BaseEntityFactoryCreateProps {
  name: IUserSettingsEntity['name'];
  key: IUserSettingsEntity['key'];
  value: IUserSettingsEntity['value'];
  dataType: IUserSettingsEntity['dataType'];
  namespace?: IUserSettingsEntity['namespace'];
  userId: IUserSettingsEntity['userId'];
  User?: IUserSettingsEntity['User'];

  createdAt?: IUserSettingsEntity['createdAt'];
  updatedAt?: IUserSettingsEntity['updatedAt'];
  createdBy?: IUserSettingsEntity['createdBy'];
  updatedBy?: IUserSettingsEntity['updatedBy'];
}

export class UserSettingsFactory {
  static CreateUserSettings(props: CreateUserSettingsProps): UserSettingsEntity {
    const id = generateId();
    const now = new Date();

    return new UserSettingsEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      key: props.key,
      value: props.value,
      dataType: props.dataType,
      namespace: props.namespace ?? '',
      userId: props.userId,
      User: props.User ?? null,
    });
  }
}
