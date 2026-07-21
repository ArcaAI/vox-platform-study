/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Notification extends BaseTenantDataModel {
  public title: string;
  // Plaintext messageText / messageRichText / messageContent
  // columns DROPPED; persistence is ciphertext-only. The entity keeps these as
  // transient fields repopulated by repository decrypt-on-read. `title` is NOT
  // encrypted and remains a plaintext column.
  public type: Enums.NotificationType;
  public read: boolean;
  // Vault-Transit ciphertext columns + shared key version.
  public encryptedMessageText: Uint8Array | null;
  public encryptedMessageRichText: Uint8Array | null;
  public encryptedMessageContent: Uint8Array | null;
  public keyVersion: number | null;
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
    this.type = data.type;
    this.read = data.read;
    this.encryptedMessageText = data.encryptedMessageText;
    this.encryptedMessageRichText = data.encryptedMessageRichText;
    this.encryptedMessageContent = data.encryptedMessageContent;
    this.keyVersion = data.keyVersion;
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
