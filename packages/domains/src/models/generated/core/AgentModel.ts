/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Agent extends BaseTenantDataModel {
  public slug: string;
  public name: string;
  public description: string | null;
  public task: Enums.AgentTask;
  public versionNumber: number;
  public parentVersionId: string | null;
  public status: Enums.WorkflowDefinitionStatus;
  public isActive: boolean;
  public modelId: string;
  public instruction: JsonValue | null;
  public parameters: JsonValue | null;
  public inputSchema: JsonValue | null;
  public outputSchema: JsonValue | null;
  public tools: JsonValue | null;
  public compiledConfig: JsonValue | null;
  public compiledConfigChecksum: string | null;
  public validationReport: JsonValue | null;
  public validatedAt: Date | null;
  public publishedAt: Date | null;
  public deprecatedAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public model: Models.AiModel | undefined;
  @VirtualDbProperty()
  public fallbacks: Models.AgentModelFallback[] | undefined;

  constructor(data: Agent & BaseTenantDataModel) {
    super(data);
    this.slug = data.slug;
    this.name = data.name;
    this.description = data.description;
    this.task = data.task;
    this.versionNumber = data.versionNumber;
    this.parentVersionId = data.parentVersionId;
    this.status = data.status;
    this.isActive = data.isActive;
    this.modelId = data.modelId;
    this.instruction = data.instruction;
    this.parameters = data.parameters;
    this.inputSchema = data.inputSchema;
    this.outputSchema = data.outputSchema;
    this.tools = data.tools;
    this.compiledConfig = data.compiledConfig;
    this.compiledConfigChecksum = data.compiledConfigChecksum;
    this.validationReport = data.validationReport;
    this.validatedAt = data.validatedAt;
    this.publishedAt = data.publishedAt;
    this.deprecatedAt = data.deprecatedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.model = data.model;
    this.fallbacks = data.fallbacks;
  }
}
