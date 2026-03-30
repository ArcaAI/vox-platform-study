/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IGlobalSettingEntity extends IBaseTaggedEntity {
  name: string;
  description?: string | null;
  key: string;
  defaultValue?: string | null;
  value: string;
  dataType: Enums.ValueType;
  namespace?: string | null;
}

export class GlobalSettingEntity extends BaseTaggedEntity {
  private _name: IGlobalSettingEntity['name'];
  private _description?: IGlobalSettingEntity['description'];
  private _key: IGlobalSettingEntity['key'];
  private _defaultValue?: IGlobalSettingEntity['defaultValue'];
  private _value: IGlobalSettingEntity['value'];
  private _dataType: IGlobalSettingEntity['dataType'];
  private _namespace?: IGlobalSettingEntity['namespace'];

  constructor(init: IGlobalSettingEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._key = init.key;
    this._defaultValue = init.defaultValue;
    this._value = init.value;
    this._dataType = init.dataType;
    this._namespace = init.namespace;
  }

  get name(): IGlobalSettingEntity['name'] {
    return this._name;
  }

  set name(value: IGlobalSettingEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IGlobalSettingEntity['description'] {
    return this._description;
  }

  set description(value: IGlobalSettingEntity['description']) {
    this.setProperty('description', value);
  }

  get key(): IGlobalSettingEntity['key'] {
    return this._key;
  }

  set key(value: IGlobalSettingEntity['key']) {
    this.setProperty('key', value);
  }

  get defaultValue(): IGlobalSettingEntity['defaultValue'] {
    return this._defaultValue;
  }

  set defaultValue(value: IGlobalSettingEntity['defaultValue']) {
    this.setProperty('defaultValue', value);
  }

  get value(): IGlobalSettingEntity['value'] {
    return this._value;
  }

  set value(value: IGlobalSettingEntity['value']) {
    this.setProperty('value', value);
  }

  get parsedValue(): any {
    if (this.dataType === Enums.ValueType.Boolean) {
      return this.value === 'true';
    } else if (this.dataType === Enums.ValueType.Integer) {
      return parseInt(this.value, 10);
    } else if (this.dataType === Enums.ValueType.Float) {
      return parseFloat(this.value);
    } else if (this.dataType === Enums.ValueType.DateTime) {
      return new Date(this.value);
    } else if (this.dataType === Enums.ValueType.Json) {
      return JSON.parse(this.value);
    } else if (this.dataType === Enums.ValueType.Array) {
      return JSON.parse(this.value);
    } else if (this.dataType === Enums.ValueType.Decimal) {
      return new Decimal(this.value);
    }
    return this.value;
  }

  get dataType(): IGlobalSettingEntity['dataType'] {
    return this._dataType;
  }

  set dataType(value: IGlobalSettingEntity['dataType']) {
    this.setProperty('dataType', value);
  }

  get namespace(): IGlobalSettingEntity['namespace'] {
    return this._namespace;
  }

  set namespace(value: IGlobalSettingEntity['namespace']) {
    this.setProperty('namespace', value);
  }

  public override validate(): void {
    throw new BusinessException('Method not implemented.');
  }
}
