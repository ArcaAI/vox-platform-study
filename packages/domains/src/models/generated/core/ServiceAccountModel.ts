/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ServiceAccount extends BaseTenantDataModel {
  public clientId: string;
  public displayName: string;
  public description: string | null;
  public scopes: JsonValue;
  public allowedTenantIds: JsonValue | null;
  public allowedIps: JsonValue | null;
  public superAdmin: boolean;
  public tokenTtlSeconds: number;
  public lastUsedAt: Date | null;
  public credentialsRef: string;
  public secretVerifier: string;
  public previousCredentialsRef: string | null;
  public previousSecretVerifier: string | null;
  public previousCredentialExpiresAt: Date | null;
  public rotatedAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: ServiceAccount & BaseTenantDataModel) {
    super(data);
    this.clientId = data.clientId;
    this.displayName = data.displayName;
    this.description = data.description;
    this.scopes = data.scopes;
    this.allowedTenantIds = data.allowedTenantIds;
    this.allowedIps = data.allowedIps;
    this.superAdmin = data.superAdmin;
    this.tokenTtlSeconds = data.tokenTtlSeconds;
    this.lastUsedAt = data.lastUsedAt;
    this.credentialsRef = data.credentialsRef;
    this.secretVerifier = data.secretVerifier;
    this.previousCredentialsRef = data.previousCredentialsRef;
    this.previousSecretVerifier = data.previousSecretVerifier;
    this.previousCredentialExpiresAt = data.previousCredentialExpiresAt;
    this.rotatedAt = data.rotatedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
