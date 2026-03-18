/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IWebhookEntity extends IBaseTaggedEntity {
    name: string;
    url: string;
    hashedSecret?: string | null;
    resourceTypeName: string;
    resourceId?: string | null;
    subscriptionMetadata?: JsonValue | null;
    WebhookRunHistorys?: Entities.WebhookRunHistoryEntity[] | null;
}

export class WebhookEntity extends BaseTaggedEntity {
    private _name: IWebhookEntity['name'];
    private _url: IWebhookEntity['url'];
    private _hashedSecret?: IWebhookEntity['hashedSecret'];
    private _resourceTypeName: IWebhookEntity['resourceTypeName'];
    private _resourceId?: IWebhookEntity['resourceId'];
    private _subscriptionMetadata?: IWebhookEntity['subscriptionMetadata'];
    private _WebhookRunHistorys?: IWebhookEntity['WebhookRunHistorys'];

    constructor(init: IWebhookEntity) {
        super(init);
        this._name = init.name;
        this._url = init.url;
        this._hashedSecret = init.hashedSecret;
        this._resourceTypeName = init.resourceTypeName;
        this._resourceId = init.resourceId;
        this._subscriptionMetadata = init.subscriptionMetadata;
        this._WebhookRunHistorys = init.WebhookRunHistorys;
    }

    get name(): IWebhookEntity['name'] {
        return this._name;
    }

    set name(value: IWebhookEntity['name']) {
        this.setProperty('name', value);
    }

    get url(): IWebhookEntity['url'] {
        return this._url;
    }

    set url(value: IWebhookEntity['url']) {
        this.setProperty('url', value);
    }

    get hashedSecret(): IWebhookEntity['hashedSecret'] {
        return this._hashedSecret;
    }

    set hashedSecret(value: IWebhookEntity['hashedSecret']) {
        this.setProperty('hashedSecret', value);
    }

    get resourceTypeName(): IWebhookEntity['resourceTypeName'] {
        return this._resourceTypeName;
    }

    set resourceTypeName(value: IWebhookEntity['resourceTypeName']) {
        this.setProperty('resourceTypeName', value);
    }

    get resourceId(): IWebhookEntity['resourceId'] {
        return this._resourceId;
    }

    set resourceId(value: IWebhookEntity['resourceId']) {
        this.setProperty('resourceId', value);
    }

    get subscriptionMetadata(): IWebhookEntity['subscriptionMetadata'] {
        return this._subscriptionMetadata;
    }

    set subscriptionMetadata(value: IWebhookEntity['subscriptionMetadata']) {
        this.setProperty('subscriptionMetadata', value);
    }

    get WebhookRunHistorys(): IWebhookEntity['WebhookRunHistorys'] {
        return this._WebhookRunHistorys;
    }

    set WebhookRunHistorys(value: IWebhookEntity['WebhookRunHistorys']) {
        this.setProperty('WebhookRunHistorys', value);
    }

    public override validate(): void {
        throw new BusinessException('Method not implemented.');
    }
}