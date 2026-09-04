/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class WorkflowWebhookSecret extends BaseTenantDataModel {
  public workflowSlug: string;
  public encryptedSecret: string;
  public rotatedAt: Date;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: WorkflowWebhookSecret & BaseTenantDataModel) {
    super(data);
    this.workflowSlug = data.workflowSlug;
    this.encryptedSecret = data.encryptedSecret;
    this.rotatedAt = data.rotatedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
