/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class WorkflowAssignment extends BaseTenantDataModel {
  public scope: Enums.PipelinePolicyScope;
  public scopeId: string | null;
  public paletteKey: string;
  public workflowDefinitionSlug: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: WorkflowAssignment & BaseTenantDataModel) {
    super(data);
    this.scope = data.scope;
    this.scopeId = data.scopeId;
    this.paletteKey = data.paletteKey;
    this.workflowDefinitionSlug = data.workflowDefinitionSlug;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
