/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IUserEntity extends Omit<IBaseTaggedEntity, 'tenantId'> {
  username: string;
  password: string;
  lastLoginAt?: Date | null;
  lastActiveAt?: Date | null;
  externalId?: string | null;
  isServiceAccount: boolean;
  secret1?: string | null;
  secret1Expiry?: Date | null;
  secret2?: string | null;
  secret2Expiry?: Date | null;
  UserProfile?: Entities.UserProfileEntity | null;
  UserSettings?: Entities.UserSettingsEntity[] | null;
  UserRoleAssignments?: Entities.UserRoleAssignmentEntity[] | null;
  UserNotifications?: Entities.NotificationEntity[] | null;
  ResourceSubscriptions?: Entities.ResourceSubscriptionEntity[] | null;
  UserMedias?: Entities.UserMediaEntity[] | null;
}

export class UserEntity extends BaseTaggedEntity {
  private _username: IUserEntity['username'];
  private _password: IUserEntity['password'];
  private _lastLoginAt?: IUserEntity['lastLoginAt'];
  private _lastActiveAt?: IUserEntity['lastActiveAt'];
  private _externalId?: IUserEntity['externalId'];
  private _isServiceAccount: IUserEntity['isServiceAccount'];
  private _secret1?: IUserEntity['secret1'];
  private _secret1Expiry?: IUserEntity['secret1Expiry'];
  private _secret2?: IUserEntity['secret2'];
  private _secret2Expiry?: IUserEntity['secret2Expiry'];
  private _UserProfile?: IUserEntity['UserProfile'];
  private _UserSettings?: IUserEntity['UserSettings'];
  private _UserRoleAssignments?: IUserEntity['UserRoleAssignments'];
  private _UserNotifications?: IUserEntity['UserNotifications'];
  private _ResourceSubscriptions?: IUserEntity['ResourceSubscriptions'];
  private _UserMedias?: IUserEntity['UserMedias'];

  constructor(init: IUserEntity) {
    super(init);
    this._username = init.username;
    this._password = init.password;
    this._lastLoginAt = init.lastLoginAt;
    this._lastActiveAt = init.lastActiveAt;
    this._externalId = init.externalId;
    this._isServiceAccount = init.isServiceAccount;
    this._secret1 = init.secret1;
    this._secret1Expiry = init.secret1Expiry;
    this._secret2 = init.secret2;
    this._secret2Expiry = init.secret2Expiry;
    this._UserProfile = init.UserProfile;
    this._UserSettings = init.UserSettings;
    this._UserRoleAssignments = init.UserRoleAssignments;
    this._UserNotifications = init.UserNotifications;
    this._ResourceSubscriptions = init.ResourceSubscriptions;
    this._UserMedias = init.UserMedias;
  }

  get username(): IUserEntity['username'] {
    return this._username;
  }

  set username(value: IUserEntity['username']) {
    this.setProperty('username', value);
  }

  get password(): IUserEntity['password'] {
    return this._password;
  }

  set password(value: IUserEntity['password']) {
    this.setProperty('password', value);
  }

  get lastLoginAt(): IUserEntity['lastLoginAt'] {
    return this._lastLoginAt;
  }

  set lastLoginAt(value: IUserEntity['lastLoginAt']) {
    this.setProperty('lastLoginAt', value);
  }

  get lastActiveAt(): IUserEntity['lastActiveAt'] {
    return this._lastActiveAt;
  }

  set lastActiveAt(value: IUserEntity['lastActiveAt']) {
    this.setProperty('lastActiveAt', value);
  }

  get externalId(): IUserEntity['externalId'] {
    return this._externalId;
  }

  set externalId(value: IUserEntity['externalId']) {
    this.setProperty('externalId', value);
  }

  get isServiceAccount(): IUserEntity['isServiceAccount'] {
    return this._isServiceAccount;
  }

  set isServiceAccount(value: IUserEntity['isServiceAccount']) {
    this.setProperty('isServiceAccount', value);
  }

  get secret1(): IUserEntity['secret1'] {
    return this._secret1;
  }

  set secret1(value: IUserEntity['secret1']) {
    this.setProperty('secret1', value);
  }

  get secret1Expiry(): IUserEntity['secret1Expiry'] {
    return this._secret1Expiry;
  }

  set secret1Expiry(value: IUserEntity['secret1Expiry']) {
    this.setProperty('secret1Expiry', value);
  }

  get secret2(): IUserEntity['secret2'] {
    return this._secret2;
  }

  set secret2(value: IUserEntity['secret2']) {
    this.setProperty('secret2', value);
  }

  get secret2Expiry(): IUserEntity['secret2Expiry'] {
    return this._secret2Expiry;
  }

  set secret2Expiry(value: IUserEntity['secret2Expiry']) {
    this.setProperty('secret2Expiry', value);
  }

  get UserProfile(): IUserEntity['UserProfile'] {
    return this._UserProfile;
  }

  set UserProfile(value: IUserEntity['UserProfile']) {
    this.setProperty('UserProfile', value);
  }

  get UserSettings(): IUserEntity['UserSettings'] {
    return this._UserSettings;
  }

  set UserSettings(value: IUserEntity['UserSettings']) {
    this.setProperty('UserSettings', value);
  }

  get UserRoleAssignments(): IUserEntity['UserRoleAssignments'] {
    return this._UserRoleAssignments;
  }

  set UserRoleAssignments(value: IUserEntity['UserRoleAssignments']) {
    this.setProperty('UserRoleAssignments', value);
  }

  get UserNotifications(): IUserEntity['UserNotifications'] {
    return this._UserNotifications;
  }

  set UserNotifications(value: IUserEntity['UserNotifications']) {
    this.setProperty('UserNotifications', value);
  }

  get ResourceSubscriptions(): IUserEntity['ResourceSubscriptions'] {
    return this._ResourceSubscriptions;
  }

  set ResourceSubscriptions(value: IUserEntity['ResourceSubscriptions']) {
    this.setProperty('ResourceSubscriptions', value);
  }

  get UserMedias(): IUserEntity['UserMedias'] {
    return this._UserMedias;
  }

  set UserMedias(value: IUserEntity['UserMedias']) {
    this.setProperty('UserMedias', value);
  }

  public override validate(): void {
    if (!this._username || this._username.trim().length === 0) {
      throw new BusinessException('User username is required.');
    }
    if (this._username.length > 255) {
      throw new BusinessException('User username must not exceed 255 characters.');
    }
    if (!this._password || this._password.trim().length === 0) {
      throw new BusinessException('User password is required.');
    }
    if (typeof this._isServiceAccount !== 'boolean') {
      throw new BusinessException('User isServiceAccount must be a boolean.');
    }
    if (this._externalId && this._externalId.length > 255) {
      throw new BusinessException('User externalId must not exceed 255 characters.');
    }
    if (this._secret1 && this._secret1.length > 255) {
      throw new BusinessException('User secret1 must not exceed 255 characters.');
    }
    if (this._secret2 && this._secret2.length > 255) {
      throw new BusinessException('User secret2 must not exceed 255 characters.');
    }
  }
}
