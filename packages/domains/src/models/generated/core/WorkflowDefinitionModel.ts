/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class WorkflowDefinition extends BaseTenantDataModel {
  public slug: string;
  public name: string;
  public description: string | null;
  public paletteKey: string;
  public versionNumber: number;
  public parentVersionId: string | null;
  public status: Enums.WorkflowDefinitionStatus;
  public sourceTemplateSlug: string | null;
  public templateLocked: boolean;
  public graph: JsonValue;
  public graphChecksum: string;
  public compiledConfig: JsonValue | null;
  public compiledConfigChecksum: string | null;
  public registryChecksum: string | null;
  public validationReport: JsonValue | null;
  public needsReview: boolean;
  public validatedAt: Date | null;
  public publishedAt: Date | null;
  public deprecatedAt: Date | null;
  public isActive: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];

  constructor(data: WorkflowDefinition & BaseTenantDataModel) {
    super(data);
    this.slug = data.slug;
    this.name = data.name;
    this.description = data.description;
    this.paletteKey = data.paletteKey;
    this.versionNumber = data.versionNumber;
    this.parentVersionId = data.parentVersionId;
    this.status = data.status;
    this.sourceTemplateSlug = data.sourceTemplateSlug;
    this.templateLocked = data.templateLocked;
    this.graph = data.graph;
    this.graphChecksum = data.graphChecksum;
    this.compiledConfig = data.compiledConfig;
    this.compiledConfigChecksum = data.compiledConfigChecksum;
    this.registryChecksum = data.registryChecksum;
    this.validationReport = data.validationReport;
    this.needsReview = data.needsReview;
    this.validatedAt = data.validatedAt;
    this.publishedAt = data.publishedAt;
    this.deprecatedAt = data.deprecatedAt;
    this.isActive = data.isActive;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
  }
}
