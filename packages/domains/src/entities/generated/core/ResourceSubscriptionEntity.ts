/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IResourceSubscriptionEntity extends IBaseTaggedEntity {
  resourceId?: string | null;
  resourceTypeName?: string | null;
  subscriptionType: Enums.ResourceSubscriptionType;
  targetUserId: string;
  subscriptionMetadata?: JsonValue | null;
  Subscribers?: Entities.UserEntity[] | null;
  Notifications?: Entities.NotificationEntity[] | null;
}

export class ResourceSubscriptionEntity extends BaseTaggedEntity {
  private _resourceId?: IResourceSubscriptionEntity['resourceId'];
  private _resourceTypeName?: IResourceSubscriptionEntity['resourceTypeName'];
  private _subscriptionType: IResourceSubscriptionEntity['subscriptionType'];
  private _targetUserId: IResourceSubscriptionEntity['targetUserId'];
  private _subscriptionMetadata?: IResourceSubscriptionEntity['subscriptionMetadata'];
  private _Subscribers?: IResourceSubscriptionEntity['Subscribers'];
  private _Notifications?: IResourceSubscriptionEntity['Notifications'];

  constructor(init: IResourceSubscriptionEntity) {
    super(init);
    this._resourceId = init.resourceId;
    this._resourceTypeName = init.resourceTypeName;
    this._subscriptionType = init.subscriptionType;
    this._targetUserId = init.targetUserId;
    this._subscriptionMetadata = init.subscriptionMetadata;
    this._Subscribers = init.Subscribers;
    this._Notifications = init.Notifications;
  }

  get resourceId(): IResourceSubscriptionEntity['resourceId'] {
    return this._resourceId;
  }

  set resourceId(value: IResourceSubscriptionEntity['resourceId']) {
    this.setProperty('resourceId', value);
  }

  get resourceTypeName(): IResourceSubscriptionEntity['resourceTypeName'] {
    return this._resourceTypeName;
  }

  set resourceTypeName(value: IResourceSubscriptionEntity['resourceTypeName']) {
    this.setProperty('resourceTypeName', value);
  }

  get subscriptionType(): IResourceSubscriptionEntity['subscriptionType'] {
    return this._subscriptionType;
  }

  set subscriptionType(value: IResourceSubscriptionEntity['subscriptionType']) {
    this.setProperty('subscriptionType', value);
  }

  get targetUserId(): IResourceSubscriptionEntity['targetUserId'] {
    return this._targetUserId;
  }

  set targetUserId(value: IResourceSubscriptionEntity['targetUserId']) {
    this.setProperty('targetUserId', value);
  }

  get subscriptionMetadata(): IResourceSubscriptionEntity['subscriptionMetadata'] {
    return this._subscriptionMetadata;
  }

  set subscriptionMetadata(value: IResourceSubscriptionEntity['subscriptionMetadata']) {
    this.setProperty('subscriptionMetadata', value);
  }

  get Subscribers(): IResourceSubscriptionEntity['Subscribers'] {
    return this._Subscribers;
  }

  set Subscribers(value: IResourceSubscriptionEntity['Subscribers']) {
    this.setProperty('Subscribers', value);
  }

  get Notifications(): IResourceSubscriptionEntity['Notifications'] {
    return this._Notifications;
  }

  set Notifications(value: IResourceSubscriptionEntity['Notifications']) {
    this.setProperty('Notifications', value);
  }

  public override validate(): void {
    if (this._subscriptionType === undefined || this._subscriptionType === null) {
      throw new BusinessException('Resource subscription subscriptionType is required.');
    }
    if (!Object.values(Enums.ResourceSubscriptionType).includes(this._subscriptionType)) {
      throw new BusinessException(
        `Resource subscription subscriptionType is invalid: ${String(this._subscriptionType)}.`,
      );
    }
    if (!this._targetUserId || this._targetUserId.trim().length === 0) {
      throw new BusinessException('Resource subscription targetUserId is required.');
    }
    if (
      this._resourceId !== null &&
      this._resourceId !== undefined &&
      this._resourceId.trim().length === 0
    ) {
      throw new BusinessException('Resource subscription resourceId must not be empty when provided.');
    }
    if (this._resourceTypeName && this._resourceTypeName.length > 255) {
      throw new BusinessException('Resource subscription resourceTypeName must not exceed 255 characters.');
    }
  }
}
