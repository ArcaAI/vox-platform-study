/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Notification extends BaseTenantDataModel {
  public title: string;
  public messageText: string | null;
  public messageRichText: string | null;
  public messageContent: JsonValue | null;
  public type: Enums.NotificationType;
  public read: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  public resourceSubscriptionId: string | null;
  public targetUserId: string;
  @VirtualDbProperty()
  public ResourceSubscription: Models.ResourceSubscription | undefined;
  @VirtualDbProperty()
  public TargetUser: Models.User | undefined;

  constructor(data: Notification & BaseTenantDataModel) {
    super(data);
    this.title = data.title;
    this.messageText = data.messageText;
    this.messageRichText = data.messageRichText;
    this.messageContent = data.messageContent;
    this.type = data.type;
    this.read = data.read;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.resourceSubscriptionId = data.resourceSubscriptionId;
    this.targetUserId = data.targetUserId;
    this.ResourceSubscription = data.ResourceSubscription;
    this.TargetUser = data.TargetUser;
  }
}
