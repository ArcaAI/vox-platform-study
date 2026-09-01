/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiRoutingPolicy extends BaseTenantDataModel {
  public taskKey: string;
  public taskKind: Enums.AiTaskKind | null;
  public displayName: string | null;
  public providerConnectionId: string | null;
  public modelId: string | null;
  public modelRef: string | null;
  public isDefault: boolean;
  public enabled: boolean;
  public residency: string | null;
  public baaCovered: boolean | null;
  public configJson: JsonValue | null;
  public policyVersion: number;
  public status: Enums.AiRoutingPolicyStatus;
  public strategy: Enums.AiRoutingStrategy;
  public explicitProviderMode: Enums.AiExplicitProviderMode;
  public priority: number;
  public killSwitch: boolean;
  public matchJson: JsonValue | null;
  public candidatesJson: JsonValue | null;
  public fallbackJson: JsonValue | null;
  public healthJson: JsonValue | null;
  public maxConcurrentStreams: number | null;
  public requestsPerMinute: number | null;
  public tokensPerMinute: number | null;
  public affinityJson: JsonValue | null;
  public supersedesVersion: number | null;
  public activatedAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public providerConnection: Models.AiProviderConnection | undefined;
  @VirtualDbProperty()
  public model: Models.AiModel | undefined;

  constructor(data: AiRoutingPolicy & BaseTenantDataModel) {
    super(data);
    this.taskKey = data.taskKey;
    this.taskKind = data.taskKind;
    this.displayName = data.displayName;
    this.providerConnectionId = data.providerConnectionId;
    this.modelId = data.modelId;
    this.modelRef = data.modelRef;
    this.isDefault = data.isDefault;
    this.enabled = data.enabled;
    this.residency = data.residency;
    this.baaCovered = data.baaCovered;
    this.configJson = data.configJson;
    this.policyVersion = data.policyVersion;
    this.status = data.status;
    this.strategy = data.strategy;
    this.explicitProviderMode = data.explicitProviderMode;
    this.priority = data.priority;
    this.killSwitch = data.killSwitch;
    this.matchJson = data.matchJson;
    this.candidatesJson = data.candidatesJson;
    this.fallbackJson = data.fallbackJson;
    this.healthJson = data.healthJson;
    this.maxConcurrentStreams = data.maxConcurrentStreams;
    this.requestsPerMinute = data.requestsPerMinute;
    this.tokensPerMinute = data.tokensPerMinute;
    this.affinityJson = data.affinityJson;
    this.supersedesVersion = data.supersedesVersion;
    this.activatedAt = data.activatedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.providerConnection = data.providerConnection;
    this.model = data.model;
  }
}
