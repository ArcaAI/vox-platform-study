/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class User extends BaseDataModel {
  public username: string;
  public password: string;
  public lastLoginAt: Date | null;
  public lastActiveAt: Date | null;
  public externalId: string | null;
  public isServiceAccount: boolean;
  public secret1: string | null;
  public secret1Expiry: Date | null;
  public secret2: string | null;
  public secret2Expiry: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public UserProfile: Models.UserProfile | undefined;
  @VirtualDbProperty()
  public UserSettings: Models.UserSettings[] | undefined;
  @VirtualDbProperty()
  public UserRoleAssignments: Models.UserRoleAssignment[] | undefined;
  @VirtualDbProperty()
  public UserNotifications: Models.Notification[] | undefined;
  @VirtualDbProperty()
  public ResourceSubscriptions: Models.ResourceSubscription[] | undefined;
  @VirtualDbProperty()
  public UserMedias: Models.UserMedia[] | undefined;

  constructor(data: User & BaseDataModel) {
    super(data);
    this.username = data.username;
    this.password = data.password;
    this.lastLoginAt = data.lastLoginAt;
    this.lastActiveAt = data.lastActiveAt;
    this.externalId = data.externalId;
    this.isServiceAccount = data.isServiceAccount;
    this.secret1 = data.secret1;
    this.secret1Expiry = data.secret1Expiry;
    this.secret2 = data.secret2;
    this.secret2Expiry = data.secret2Expiry;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.UserProfile = data.UserProfile;
    this.UserSettings = data.UserSettings;
    this.UserRoleAssignments = data.UserRoleAssignments;
    this.UserNotifications = data.UserNotifications;
    this.ResourceSubscriptions = data.ResourceSubscriptions;
    this.UserMedias = data.UserMedias;
  }
}
