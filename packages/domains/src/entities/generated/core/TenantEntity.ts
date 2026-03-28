/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface ITenantEntity extends Omit<IBaseTaggedEntity, 'tenantId'> {
  name: string;
  key: string;
  description?: string | null;
}

export class TenantEntity extends BaseTaggedEntity {
  private _name: ITenantEntity['name'];
  private _key: ITenantEntity['key'];
  private _description?: ITenantEntity['description'];

  constructor(init: ITenantEntity) {
    super(init);
    this._name = init.name;
    this._key = init.key;
    this._description = init.description;
  }

  get name(): ITenantEntity['name'] {
    return this._name;
  }

  set name(value: ITenantEntity['name']) {
    this.setProperty('name', value);
  }

  get key(): ITenantEntity['key'] {
    return this._key;
  }

  set key(value: ITenantEntity['key']) {
    this.setProperty('key', value);
  }

  get description(): ITenantEntity['description'] {
    return this._description;
  }

  set description(value: ITenantEntity['description']) {
    this.setProperty('description', value);
  }

  public override validate(): void {
    throw new BusinessException('Method not implemented.');
  }
}
