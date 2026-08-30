/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiRoutingPolicy extends BaseTenantDataModel {
  public taskKey: string;
  public policyVersion: number;
  public status: Enums.AiRoutingPolicyStatus;
  public strategy: Enums.AiRoutingStrategy;
  public explicitProviderMode: Enums.AiExplicitProviderMode;
  public priority: number;
  public killSwitch: boolean;
  public matchJson: JsonValue | null;
  public candidatesJson: JsonValue;
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

  constructor(data: AiRoutingPolicy & BaseTenantDataModel) {
    super(data);
    this.taskKey = data.taskKey;
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
  }
}
