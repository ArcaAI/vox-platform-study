/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IUserSettingsEntity extends Omit<IBaseEntity, 'tenantId'> {
  name: string;
  key: string;
  value: string;
  dataType: Enums.ValueType;
  namespace?: string | null;
  userId: string;
  User: Entities.UserEntity | null;
}

export class UserSettingsEntity extends BaseEntity {
  private _name: IUserSettingsEntity['name'];
  private _key: IUserSettingsEntity['key'];
  private _value: IUserSettingsEntity['value'];
  private _dataType: IUserSettingsEntity['dataType'];
  private _namespace?: IUserSettingsEntity['namespace'];
  private _userId: IUserSettingsEntity['userId'];
  private _User: IUserSettingsEntity['User'];

  constructor(init: IUserSettingsEntity) {
    super(init);
    this._name = init.name;
    this._key = init.key;
    this._value = init.value;
    this._dataType = init.dataType;
    this._namespace = init.namespace;
    this._userId = init.userId;
    this._User = init.User;
  }

  get name(): IUserSettingsEntity['name'] {
    return this._name;
  }

  set name(value: IUserSettingsEntity['name']) {
    this.setProperty('name', value);
  }

  get key(): IUserSettingsEntity['key'] {
    return this._key;
  }

  set key(value: IUserSettingsEntity['key']) {
    this.setProperty('key', value);
  }

  get value(): IUserSettingsEntity['value'] {
    return this._value;
  }

  set value(value: IUserSettingsEntity['value']) {
    this.setProperty('value', value);
  }

  get dataType(): IUserSettingsEntity['dataType'] {
    return this._dataType;
  }

  set dataType(value: IUserSettingsEntity['dataType']) {
    this.setProperty('dataType', value);
  }

  get namespace(): IUserSettingsEntity['namespace'] {
    return this._namespace;
  }

  set namespace(value: IUserSettingsEntity['namespace']) {
    this.setProperty('namespace', value);
  }

  get userId(): IUserSettingsEntity['userId'] {
    return this._userId;
  }

  set userId(value: IUserSettingsEntity['userId']) {
    this.setProperty('userId', value);
  }

  get User(): IUserSettingsEntity['User'] {
    return this._User;
  }

  set User(value: IUserSettingsEntity['User']) {
    this.setProperty('User', value);
  }

  public override validate(): void {
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('User settings name is required.');
    }
    if (this._name.length > 255) {
      throw new BusinessException('User settings name must not exceed 255 characters.');
    }
    if (!this._key || this._key.trim().length === 0) {
      throw new BusinessException('User settings key is required.');
    }
    if (this._key.length > 100) {
      throw new BusinessException('User settings key must not exceed 100 characters.');
    }
    if (typeof this._value !== 'string') {
      throw new BusinessException('User settings value must be a string.');
    }
    if (this._dataType === undefined || this._dataType === null) {
      throw new BusinessException('User settings dataType is required.');
    }
    if (!Object.values(Enums.ValueType).includes(this._dataType)) {
      throw new BusinessException(`User settings dataType is invalid: ${String(this._dataType)}.`);
    }
    if (this._namespace && this._namespace.length > 100) {
      throw new BusinessException('User settings namespace must not exceed 100 characters.');
    }
    if (!this._userId || this._userId.trim().length === 0) {
      throw new BusinessException('User settings userId is required.');
    }
  }
}
