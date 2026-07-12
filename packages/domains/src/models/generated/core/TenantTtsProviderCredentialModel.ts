/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantTtsProviderCredential extends BaseTenantDataModel {
  public provider: string;
  public endpoint: string | null;
  public encryptedApiKey: Uint8Array | null;
  public keyVersion: number | null;
  public enabled: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantTtsProviderCredential & BaseTenantDataModel) {
    super(data);
    this.provider = data.provider;
    this.endpoint = data.endpoint;
    this.encryptedApiKey = data.encryptedApiKey;
    this.keyVersion = data.keyVersion;
    this.enabled = data.enabled;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
