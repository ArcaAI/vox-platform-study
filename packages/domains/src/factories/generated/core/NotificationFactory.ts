/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { NotificationEntity, INotificationEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateNotificationProps extends BaseEntityFactoryCreateProps {
  title: INotificationEntity['title'];
  messageText?: INotificationEntity['messageText'];
  messageRichText?: INotificationEntity['messageRichText'];
  messageContent?: INotificationEntity['messageContent'];
  type: INotificationEntity['type'];
  read: INotificationEntity['read'];
  resourceSubscriptionId?: INotificationEntity['resourceSubscriptionId'];
  ResourceSubscription?: INotificationEntity['ResourceSubscription'];
  targetUserId: INotificationEntity['targetUserId'];
  TargetUser?: INotificationEntity['TargetUser'];
  tenantId?: INotificationEntity['tenantId'];
  Tenant?: INotificationEntity['Tenant'];
  tags?: INotificationEntity['tags'];
  Tags?: INotificationEntity['Tags'];

  createdAt?: INotificationEntity['createdAt'];
  updatedAt?: INotificationEntity['updatedAt'];
  createdBy?: INotificationEntity['createdBy'];
  updatedBy?: INotificationEntity['updatedBy'];
}

export class NotificationFactory {
  static CreateNotification(props: CreateNotificationProps): NotificationEntity {
    const id = generateId();
    const now = new Date();

    return new NotificationEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      title: props.title,
      messageText: props.messageText ?? '',
      messageRichText: props.messageRichText ?? '',
      messageContent: props.messageContent ?? null,
      type: props.type,
      read: props.read,
      resourceSubscriptionId: props.resourceSubscriptionId ?? '',
      ResourceSubscription: props.ResourceSubscription ?? null,
      targetUserId: props.targetUserId,
      TargetUser: props.TargetUser ?? null,
      tenantId: props.tenantId ?? '',
      Tenant: props.Tenant ?? null,
      tags: props.tags ?? [],
      Tags: props.Tags ?? [],
    });
  }
}
