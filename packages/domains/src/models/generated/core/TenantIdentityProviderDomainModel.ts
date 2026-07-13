/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantIdentityProviderDomain extends BaseTenantDataModel {
  public domain: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public providerId: string;
  @VirtualDbProperty()
  public Provider: Models.TenantIdentityProvider | undefined;

  constructor(data: TenantIdentityProviderDomain & BaseTenantDataModel) {
    super(data);
    this.domain = data.domain;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.providerId = data.providerId;
    this.Provider = data.Provider;
  }
}
