/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiModel extends BaseTenantDataModel {
  public name: string;
  public slug: string;
  public description: string | null;
  public category: Enums.ModelCategory;
  public taskType: Enums.ModelTaskType;
  public modelType: Enums.ModelType;
  public source: Enums.AiModelSource;
  public sourceUri: string;
  public sourceRevision: string | null;
  public format: Enums.AiModelFormat;
  public provider: string | null;
  public architecture: string | null;
  public memorySizeMb: number | null;
  public computeType: string | null;
  public downloadStatus: Enums.AiModelDownloadStatus;
  public localPath: string | null;
  public downloadedAt: Date | null;
  public fileSizeMb: number | null;
  public checksum: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public routingPolicies: Models.AiRoutingPolicy[] | undefined;
  @VirtualDbProperty()
  public agents: Models.Agent[] | undefined;
  @VirtualDbProperty()
  public agentFallbacks: Models.AgentModelFallback[] | undefined;

  constructor(data: AiModel & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.slug = data.slug;
    this.description = data.description;
    this.category = data.category;
    this.taskType = data.taskType;
    this.modelType = data.modelType;
    this.source = data.source;
    this.sourceUri = data.sourceUri;
    this.sourceRevision = data.sourceRevision;
    this.format = data.format;
    this.provider = data.provider;
    this.architecture = data.architecture;
    this.memorySizeMb = data.memorySizeMb;
    this.computeType = data.computeType;
    this.downloadStatus = data.downloadStatus;
    this.localPath = data.localPath;
    this.downloadedAt = data.downloadedAt;
    this.fileSizeMb = data.fileSizeMb;
    this.checksum = data.checksum;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags ?? [];
    this.routingPolicies = data.routingPolicies;
    this.agents = data.agents;
    this.agentFallbacks = data.agentFallbacks;
  }
}
