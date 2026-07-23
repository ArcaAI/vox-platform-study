/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

/**
 * Persistence model for the editable, tenant-scoped realtime-pipeline policy.
 * Standard model — carries the inherited
 * `_version` OCC token + `resourceStatus` audit fields. The `scope`/`scopeId`
 * discriminator makes the table polymorphic across the cascade tiers; the
 * toggle columns are NULLABLE (null => inherit from the next tier up).
 */
export class PipelinePolicy extends BaseTenantDataModel {
  public scope: Enums.PipelinePolicyScope;
  public scopeId: string | null;
  public autoSummaryEnabled: boolean | null;
  public autoNerEnabled: boolean | null;
  public harnessEnabled: boolean | null;
  public dnaStyleEnabled: boolean | null;
  public dnaRedactionEnabled: boolean | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: PipelinePolicy & BaseTenantDataModel) {
    super(data);
    this.scope = data.scope;
    this.scopeId = data.scopeId;
    this.autoSummaryEnabled = data.autoSummaryEnabled;
    this.autoNerEnabled = data.autoNerEnabled;
    this.harnessEnabled = data.harnessEnabled;
    this.dnaStyleEnabled = data.dnaStyleEnabled;
    this.dnaRedactionEnabled = data.dnaRedactionEnabled;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
