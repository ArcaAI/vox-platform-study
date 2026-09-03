/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AgentModelFallback extends BaseTenantDataModel {
  public agentId: string;
  public priority: number;
  public modelId: string;
  public enabled: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public agent: Models.Agent | undefined;
  @VirtualDbProperty()
  public model: Models.AiModel | undefined;

  constructor(data: AgentModelFallback & BaseTenantDataModel) {
    super(data);
    this.agentId = data.agentId;
    this.priority = data.priority;
    this.modelId = data.modelId;
    this.enabled = data.enabled;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.agent = data.agent;
    this.model = data.model;
  }
}
