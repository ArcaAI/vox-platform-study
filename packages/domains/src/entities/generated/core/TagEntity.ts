/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface ITagEntity extends IBaseTenantEntity {
  resourceTypeName?: string | null;
  resourceId?: string | null;
  tagKey?: string | null;
  tagValue: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
}

export class TagEntity extends BaseTenantEntity {
  private _resourceTypeName?: ITagEntity['resourceTypeName'];
  private _resourceId?: ITagEntity['resourceId'];
  private _tagKey?: ITagEntity['tagKey'];
  private _tagValue: ITagEntity['tagValue'];
  private _description?: ITagEntity['description'];
  private _color?: ITagEntity['color'];
  private _icon?: ITagEntity['icon'];

  constructor(init: ITagEntity) {
    super(init);
    this._resourceTypeName = init.resourceTypeName;
    this._resourceId = init.resourceId;
    this._tagKey = init.tagKey;
    this._tagValue = init.tagValue;
    this._description = init.description;
    this._color = init.color;
    this._icon = init.icon;
  }

  get resourceTypeName(): ITagEntity['resourceTypeName'] {
    return this._resourceTypeName;
  }

  set resourceTypeName(value: ITagEntity['resourceTypeName']) {
    this.setProperty('resourceTypeName', value);
  }

  get resourceId(): ITagEntity['resourceId'] {
    return this._resourceId;
  }

  set resourceId(value: ITagEntity['resourceId']) {
    this.setProperty('resourceId', value);
  }

  get tagKey(): ITagEntity['tagKey'] {
    return this._tagKey;
  }

  set tagKey(value: ITagEntity['tagKey']) {
    this.setProperty('tagKey', value);
  }

  get tagValue(): ITagEntity['tagValue'] {
    return this._tagValue;
  }

  set tagValue(value: ITagEntity['tagValue']) {
    this.setProperty('tagValue', value);
  }

  get description(): ITagEntity['description'] {
    return this._description;
  }

  set description(value: ITagEntity['description']) {
    this.setProperty('description', value);
  }

  get color(): ITagEntity['color'] {
    return this._color;
  }

  set color(value: ITagEntity['color']) {
    this.setProperty('color', value);
  }

  get icon(): ITagEntity['icon'] {
    return this._icon;
  }

  set icon(value: ITagEntity['icon']) {
    this.setProperty('icon', value);
  }

  public override validate(): void {
    if (!this._tagValue || this._tagValue.trim().length === 0) {
      throw new BusinessException('Tag tagValue is required.');
    }
    if (this._tagValue.length > 255) {
      throw new BusinessException('Tag tagValue must not exceed 255 characters.');
    }
    if (this._tagKey && this._tagKey.length > 100) {
      throw new BusinessException('Tag tagKey must not exceed 100 characters.');
    }
    if (this._resourceTypeName && this._resourceTypeName.length > 100) {
      throw new BusinessException('Tag resourceTypeName must not exceed 100 characters.');
    }
    if (this._resourceId !== undefined && this._resourceId !== null && this._resourceId.trim().length === 0) {
      throw new BusinessException('Tag resourceId must not be blank when provided.');
    }
    if (this._description && this._description.length > 1000) {
      throw new BusinessException('Tag description must not exceed 1000 characters.');
    }
    if (this._color && this._color.length > 32) {
      throw new BusinessException('Tag color must not exceed 32 characters.');
    }
    if (this._icon && this._icon.length > 255) {
      throw new BusinessException('Tag icon must not exceed 255 characters.');
    }
  }
}
