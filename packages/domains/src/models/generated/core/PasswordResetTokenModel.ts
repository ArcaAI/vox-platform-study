/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class PasswordResetToken extends BaseDataModel {
  public tokenHash: string;
  public purpose: string;
  public expiresAt: Date;
  public usedAt: Date | null;
  public revokedAt: Date | null;
  public requestedByUserId: string | null;
  public requestedVia: string | null;
  public requestIp: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public userId: string;
  @VirtualDbProperty()
  public User: Models.User | undefined;

  constructor(data: PasswordResetToken & BaseDataModel) {
    super(data);
    this.tokenHash = data.tokenHash;
    this.purpose = data.purpose;
    this.expiresAt = data.expiresAt;
    this.usedAt = data.usedAt;
    this.revokedAt = data.revokedAt;
    this.requestedByUserId = data.requestedByUserId;
    this.requestedVia = data.requestedVia;
    this.requestIp = data.requestIp;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.userId = data.userId;
    this.User = data.User;
  }
}
