/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsultationContextSchema extends BaseTenantDataModel {
  public slug: string;
  public name: string;
  public description: string | null;
  public scope: Enums.ConsultationContextSchemaScope;
  public departmentId: string | null;
  public status: Enums.ConsultationContextSchemaStatus;
  public pinnedVersionNumber: number | null;
  public isDefault: boolean;
  public sourceTemplateSlug: string | null;
  public templateLocked: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Department: Models.Department | undefined;
  @VirtualDbProperty()
  public Versions: Models.ConsultationContextSchemaVersion[] | undefined;

  constructor(data: ConsultationContextSchema & BaseTenantDataModel) {
    super(data);
    this.slug = data.slug;
    this.name = data.name;
    this.description = data.description;
    this.scope = data.scope;
    this.departmentId = data.departmentId;
    this.status = data.status;
    this.pinnedVersionNumber = data.pinnedVersionNumber;
    this.isDefault = data.isDefault;
    this.sourceTemplateSlug = data.sourceTemplateSlug;
    this.templateLocked = data.templateLocked;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Department = data.Department;
    this.Versions = data.Versions;
  }
}
