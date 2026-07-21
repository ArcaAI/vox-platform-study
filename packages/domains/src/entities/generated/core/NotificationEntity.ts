/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface INotificationEntity extends IBaseTaggedEntity {
  title: string;
  messageText?: string | null;
  messageRichText?: string | null;
  messageContent?: JsonValue | null;
  // Vault-Transit (hope-phi) ciphertext of the message
  // fields + shared key version. Phase 6 dropped the plaintext columns;
  // plaintext survives only as transient fields repopulated by decrypt-on-read.
  encryptedMessageText?: Buffer | null;
  encryptedMessageRichText?: Buffer | null;
  encryptedMessageContent?: Buffer | null;
  keyVersion?: number | null;
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
  private _encryptedMessageText?: INotificationEntity['encryptedMessageText'];
  private _encryptedMessageRichText?: INotificationEntity['encryptedMessageRichText'];
  private _encryptedMessageContent?: INotificationEntity['encryptedMessageContent'];
  private _keyVersion?: INotificationEntity['keyVersion'];
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
    this._encryptedMessageText = init.encryptedMessageText;
    this._encryptedMessageRichText = init.encryptedMessageRichText;
    this._encryptedMessageContent = init.encryptedMessageContent;
    this._keyVersion = init.keyVersion;
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

  // Free-text clinical PHI. @Secret() marks it for
  // audit-log redaction (defense-in-depth) alongside the encrypted counterpart.
  @Secret()
  get messageText(): INotificationEntity['messageText'] {
    return this._messageText;
  }

  set messageText(value: INotificationEntity['messageText']) {
    this.setProperty('messageText', value);
  }

  @Secret()
  get messageRichText(): INotificationEntity['messageRichText'] {
    return this._messageRichText;
  }

  set messageRichText(value: INotificationEntity['messageRichText']) {
    this.setProperty('messageRichText', value);
  }

  @Secret()
  get messageContent(): INotificationEntity['messageContent'] {
    return this._messageContent;
  }

  set messageContent(value: INotificationEntity['messageContent']) {
    this.setProperty('messageContent', value);
  }

  // Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedMessageText(): INotificationEntity['encryptedMessageText'] {
    return this._encryptedMessageText;
  }

  set encryptedMessageText(value: INotificationEntity['encryptedMessageText']) {
    this.setProperty('encryptedMessageText', value);
  }

  @Secret()
  get encryptedMessageRichText(): INotificationEntity['encryptedMessageRichText'] {
    return this._encryptedMessageRichText;
  }

  set encryptedMessageRichText(value: INotificationEntity['encryptedMessageRichText']) {
    this.setProperty('encryptedMessageRichText', value);
  }

  @Secret()
  get encryptedMessageContent(): INotificationEntity['encryptedMessageContent'] {
    return this._encryptedMessageContent;
  }

  set encryptedMessageContent(value: INotificationEntity['encryptedMessageContent']) {
    this.setProperty('encryptedMessageContent', value);
  }

  get keyVersion(): INotificationEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: INotificationEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
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
    super.validate();
    if (!this._title || this._title.trim().length === 0) {
      throw new BusinessException('Notification title is required.');
    }
    if (this._title.length > 255) {
      throw new BusinessException('Notification title must not exceed 255 characters.');
    }
    if (this._type === undefined || this._type === null) {
      throw new BusinessException('Notification type is required.');
    }
    if (!Object.values(Enums.NotificationType).includes(this._type)) {
      throw new BusinessException(`Notification type is invalid: ${String(this._type)}.`);
    }
    if (typeof this._read !== 'boolean') {
      throw new BusinessException('Notification read must be a boolean.');
    }
    if (!this._targetUserId || this._targetUserId.trim().length === 0) {
      throw new BusinessException('Notification targetUserId is required.');
    }
    if (
      this._resourceSubscriptionId !== null &&
      this._resourceSubscriptionId !== undefined &&
      this._resourceSubscriptionId.trim().length === 0
    ) {
      throw new BusinessException('Notification resourceSubscriptionId must not be empty when provided.');
    }
  }
}
