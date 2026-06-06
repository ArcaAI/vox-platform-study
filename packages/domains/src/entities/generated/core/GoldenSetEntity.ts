/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IGoldenSetEntity extends IBaseTenantEntity {
  name: string;
  description?: string | null;
  pinnedVersion?: string | null;
}

export class GoldenSetEntity extends BaseTenantEntity {
  private _name: IGoldenSetEntity['name'];
  private _description?: IGoldenSetEntity['description'];
  private _pinnedVersion?: IGoldenSetEntity['pinnedVersion'];

  constructor(init: IGoldenSetEntity) {
    super(init);
    this._name = init.name;
    this._description = init.description;
    this._pinnedVersion = init.pinnedVersion;
  }

  get name(): IGoldenSetEntity['name'] {
    return this._name;
  }

  set name(value: IGoldenSetEntity['name']) {
    this.setProperty('name', value);
  }

  get description(): IGoldenSetEntity['description'] {
    return this._description;
  }

  set description(value: IGoldenSetEntity['description']) {
    this.setProperty('description', value);
  }

  get pinnedVersion(): IGoldenSetEntity['pinnedVersion'] {
    return this._pinnedVersion;
  }

  set pinnedVersion(value: IGoldenSetEntity['pinnedVersion']) {
    this.setProperty('pinnedVersion', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('GoldenSet name is required.');
    }
    if (this._name.length > 255) {
      throw new BusinessException('GoldenSet name must not exceed 255 characters.');
    }
  }
}
