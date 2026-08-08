/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DepartmentAgent extends BaseTenantDataModel {
  public departmentId: string;
  public name: string;
  public slug: string;
  public description: string | null;
  public promptTemplateId: string;
  public pinnedVersionNumber: number | null;
  public dnaStylePolicy: Enums.DepartmentAgentDnaPolicy;
  public harnessOverrides: JsonValue | null;
  public goldenSetId: string | null;
  public newPatientTemplateId: string | null;
  public revisitTemplateId: string | null;
  public preSummaryTemplateId: string | null;
  public livePromptTemplateId: string | null;
  public toolConfig: JsonValue | null;
  public llmOverrides: JsonValue | null;
  public isDefault: boolean;
  public sourceAgentTemplateSlug: string | null;
  public templateLocked: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];
  @VirtualDbProperty()
  public Department: Models.Department | undefined;
  @VirtualDbProperty()
  public PromptTemplate: Models.PromptTemplate | undefined;

  constructor(data: DepartmentAgent & BaseTenantDataModel) {
    super(data);
    this.departmentId = data.departmentId;
    this.name = data.name;
    this.slug = data.slug;
    this.description = data.description;
    this.promptTemplateId = data.promptTemplateId;
    this.pinnedVersionNumber = data.pinnedVersionNumber;
    this.dnaStylePolicy = data.dnaStylePolicy;
    this.harnessOverrides = data.harnessOverrides;
    this.goldenSetId = data.goldenSetId;
    this.newPatientTemplateId = data.newPatientTemplateId;
    this.revisitTemplateId = data.revisitTemplateId;
    this.preSummaryTemplateId = data.preSummaryTemplateId;
    this.livePromptTemplateId = data.livePromptTemplateId;
    this.toolConfig = data.toolConfig;
    this.llmOverrides = data.llmOverrides;
    this.isDefault = data.isDefault;
    this.sourceAgentTemplateSlug = data.sourceAgentTemplateSlug;
    this.templateLocked = data.templateLocked;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags;
    this.Department = data.Department;
    this.PromptTemplate = data.PromptTemplate;
  }
}
