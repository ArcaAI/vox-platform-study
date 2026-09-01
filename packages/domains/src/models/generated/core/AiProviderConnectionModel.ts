/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiProviderConnection extends BaseTenantDataModel {
  public service: string;
  public provider: string;
  public baseUrl: string | null;
  public region: string | null;
  public apiVersion: string | null;
  public deploymentName: string | null;
  public encryptedApiKey: Uint8Array | null;
  public keyVersion: number | null;
  public enabled: boolean;
  public extraJson: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public routingPolicies: Models.AiRoutingPolicy[] | undefined;

  constructor(data: AiProviderConnection & BaseTenantDataModel) {
    super(data);
    this.service = data.service;
    this.provider = data.provider;
    this.baseUrl = data.baseUrl;
    this.region = data.region;
    this.apiVersion = data.apiVersion;
    this.deploymentName = data.deploymentName;
    this.encryptedApiKey = data.encryptedApiKey;
    this.keyVersion = data.keyVersion;
    this.enabled = data.enabled;
    this.extraJson = data.extraJson;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.routingPolicies = data.routingPolicies;
  }
}
