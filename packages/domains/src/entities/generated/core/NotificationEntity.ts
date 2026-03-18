/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface INotificationEntity extends IBaseTaggedEntity {
    title: string;
    messageText?: string | null;
    messageRichText?: string | null;
    messageContent?: JsonValue | null;
    type: Enums.NotificationType;
    read: boolean;
    resourceSubscriptionId?: string | null;
    ResourceSubscription?: Entities.ResourceSubscriptionEntity | null;
    targetUserId: string;
    TargetUser: Entities.UserEntity | null;
}

export class NotificationEntity extends BaseTaggedEntity {
    private _title: INotificationEntity['title'];
    private _messageText?: INotificationEntity['messageText'];
    private _messageRichText?: INotificationEntity['messageRichText'];
    private _messageContent?: INotificationEntity['messageContent'];
    private _type: INotificationEntity['type'];
    private _read: INotificationEntity['read'];
    private _resourceSubscriptionId?: INotificationEntity['resourceSubscriptionId'];
    private _ResourceSubscription?: INotificationEntity['ResourceSubscription'];
    private _targetUserId: INotificationEntity['targetUserId'];
    private _TargetUser: INotificationEntity['TargetUser'];

    constructor(init: INotificationEntity) {
        super(init);
        this._title = init.title;
        this._messageText = init.messageText;
        this._messageRichText = init.messageRichText;
        this._messageContent = init.messageContent;
        this._type = init.type;
        this._read = init.read;
        this._resourceSubscriptionId = init.resourceSubscriptionId;
        this._ResourceSubscription = init.ResourceSubscription;
        this._targetUserId = init.targetUserId;
        this._TargetUser = init.TargetUser;
    }

    get title(): INotificationEntity['title'] {
        return this._title;
    }

    set title(value: INotificationEntity['title']) {
        this.setProperty('title', value);
    }

    get messageText(): INotificationEntity['messageText'] {
        return this._messageText;
    }

    set messageText(value: INotificationEntity['messageText']) {
        this.setProperty('messageText', value);
    }

    get messageRichText(): INotificationEntity['messageRichText'] {
        return this._messageRichText;
    }

    set messageRichText(value: INotificationEntity['messageRichText']) {
        this.setProperty('messageRichText', value);
    }

    get messageContent(): INotificationEntity['messageContent'] {
        return this._messageContent;
    }

    set messageContent(value: INotificationEntity['messageContent']) {
        this.setProperty('messageContent', value);
    }

    get type(): INotificationEntity['type'] {
        return this._type;
    }

    set type(value: INotificationEntity['type']) {
        this.setProperty('type', value);
    }

    get read(): INotificationEntity['read'] {
        return this._read;
    }

    set read(value: INotificationEntity['read']) {
        this.setProperty('read', value);
    }

    get resourceSubscriptionId(): INotificationEntity['resourceSubscriptionId'] {
        return this._resourceSubscriptionId;
    }

    set resourceSubscriptionId(value: INotificationEntity['resourceSubscriptionId']) {
        this.setProperty('resourceSubscriptionId', value);
    }

    get ResourceSubscription(): INotificationEntity['ResourceSubscription'] {
        return this._ResourceSubscription;
    }

    set ResourceSubscription(value: INotificationEntity['ResourceSubscription']) {
        this.setProperty('ResourceSubscription', value);
    }

    get targetUserId(): INotificationEntity['targetUserId'] {
        return this._targetUserId;
    }

    set targetUserId(value: INotificationEntity['targetUserId']) {
        this.setProperty('targetUserId', value);
    }

    get TargetUser(): INotificationEntity['TargetUser'] {
        return this._TargetUser;
    }

    set TargetUser(value: INotificationEntity['TargetUser']) {
        this.setProperty('TargetUser', value);
    }

    public override validate(): void {
        throw new BusinessException('Method not implemented.');
    }
}