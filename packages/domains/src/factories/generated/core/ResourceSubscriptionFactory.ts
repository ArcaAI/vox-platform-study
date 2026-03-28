/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ResourceSubscriptionEntity, IResourceSubscriptionEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateResourceSubscriptionProps extends BaseEntityFactoryCreateProps {
  resourceId?: IResourceSubscriptionEntity['resourceId'];
  resourceTypeName?: IResourceSubscriptionEntity['resourceTypeName'];
  subscriptionType: IResourceSubscriptionEntity['subscriptionType'];
  targetUserId: IResourceSubscriptionEntity['targetUserId'];
  subscriptionMetadata?: IResourceSubscriptionEntity['subscriptionMetadata'];
  Subscribers?: IResourceSubscriptionEntity['Subscribers'];
  Notifications?: IResourceSubscriptionEntity['Notifications'];
  tenantId?: IResourceSubscriptionEntity['tenantId'];
  Tenant?: IResourceSubscriptionEntity['Tenant'];
  tags?: IResourceSubscriptionEntity['tags'];
  Tags?: IResourceSubscriptionEntity['Tags'];

  createdAt?: IResourceSubscriptionEntity['createdAt'];
  updatedAt?: IResourceSubscriptionEntity['updatedAt'];
  createdBy?: IResourceSubscriptionEntity['createdBy'];
  updatedBy?: IResourceSubscriptionEntity['updatedBy'];
}

export class ResourceSubscriptionFactory {
  static CreateResourceSubscription(props: CreateResourceSubscriptionProps): ResourceSubscriptionEntity {
    const id = generateId();
    const now = new Date();

    return new ResourceSubscriptionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      resourceId: props.resourceId ?? '',
      resourceTypeName: props.resourceTypeName ?? '',
      subscriptionType: props.subscriptionType,
      targetUserId: props.targetUserId,
      subscriptionMetadata: props.subscriptionMetadata ?? null,
      Subscribers: props.Subscribers ?? [],
      Notifications: props.Notifications ?? [],
      tenantId: props.tenantId ?? '',
      Tenant: props.Tenant ?? null,
      tags: props.tags ?? [],
      Tags: props.Tags ?? [],
    });
  }
}
