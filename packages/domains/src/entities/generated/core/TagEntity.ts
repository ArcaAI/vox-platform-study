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
        throw new BusinessException('Method not implemented.');
    }
}