/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantIdentityProvider extends BaseTenantDataModel {
  public protocol: Enums.IdpProtocol;
  public displayName: string;
  public providerStatus: Enums.IdpStatus;
  public config: JsonValue;
  public encryptedSecretRef: string | null;
  public directoryCredentialsRef: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public FederatedIdentities: Models.FederatedIdentity[] | undefined;
  @VirtualDbProperty()
  public TenantIdentityProviderDomains: Models.TenantIdentityProviderDomain[] | undefined;

  constructor(data: TenantIdentityProvider & BaseTenantDataModel) {
    super(data);
    this.protocol = data.protocol;
    this.displayName = data.displayName;
    this.providerStatus = data.providerStatus;
    this.config = data.config;
    this.encryptedSecretRef = data.encryptedSecretRef;
    this.directoryCredentialsRef = data.directoryCredentialsRef;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.FederatedIdentities = data.FederatedIdentities;
    this.TenantIdentityProviderDomains = data.TenantIdentityProviderDomains;
  }
}
