/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Department extends BaseTenantDataModel {
  public code: string | null;
  public name: string | null;
  public description: string | null;
  // Prompt configuration (GAP-3)
  public defaultSummaryTemplate: string | null;
  public preSummaryPromptId: string | null;
  public newPatientPromptId: string | null;
  public revisitPromptId: string | null;
  public promptConfig: JsonValue | null;
  public parentDepartmentId: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public ParentDepartment: Models.Department | undefined;
  @VirtualDbProperty()
  public ChildDepartments: Models.Department[] | undefined;
  @VirtualDbProperty()
  public Consultations: Models.Consultation[] | undefined;
  @VirtualDbProperty()
  public PromptTemplates: Models.PromptTemplate[] | undefined;
  @VirtualDbProperty()
  public UserDepartments: Models.UserDepartment[] | undefined;

  constructor(data: Department & BaseTenantDataModel) {
    super(data);
    this.code = data.code;
    this.name = data.name;
    this.description = data.description;
    this.defaultSummaryTemplate = data.defaultSummaryTemplate;
    this.preSummaryPromptId = data.preSummaryPromptId;
    this.newPatientPromptId = data.newPatientPromptId;
    this.revisitPromptId = data.revisitPromptId;
    this.promptConfig = data.promptConfig;
    this.parentDepartmentId = data.parentDepartmentId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.ParentDepartment = data.ParentDepartment;
    this.ChildDepartments = data.ChildDepartments;
    this.Consultations = data.Consultations;
    this.PromptTemplates = data.PromptTemplates;
    this.UserDepartments = data.UserDepartments;
  }
}
