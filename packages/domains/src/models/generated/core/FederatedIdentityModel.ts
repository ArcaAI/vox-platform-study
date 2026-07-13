/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class FederatedIdentity extends BaseTenantDataModel {
  public userId: string;
  public subject: string;
  public lastLoginAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public providerId: string;
  @VirtualDbProperty()
  public Provider: Models.TenantIdentityProvider | undefined;

  constructor(data: FederatedIdentity & BaseTenantDataModel) {
    super(data);
    this.userId = data.userId;
    this.subject = data.subject;
    this.lastLoginAt = data.lastLoginAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.providerId = data.providerId;
    this.Provider = data.Provider;
  }
}
