/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DocumentTemplate extends BaseTenantDataModel {
  public slug: string;
  public name: string;
  public description: string | null;
  public status: Enums.DocumentTemplateStatus;
  public pinnedVersionNumber: number | null;
  public isDefault: boolean;
  public sourceTemplateSlug: string | null;
  public templateLocked: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Versions: Models.DocumentTemplateVersion[] | undefined;

  constructor(data: DocumentTemplate & BaseTenantDataModel) {
    super(data);
    this.slug = data.slug;
    this.name = data.name;
    this.description = data.description;
    this.status = data.status;
    this.pinnedVersionNumber = data.pinnedVersionNumber;
    this.isDefault = data.isDefault;
    this.sourceTemplateSlug = data.sourceTemplateSlug;
    this.templateLocked = data.templateLocked;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Versions = data.Versions;
  }
}
