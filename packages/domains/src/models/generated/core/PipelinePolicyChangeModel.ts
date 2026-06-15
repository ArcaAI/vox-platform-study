/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

/**
 * Persistence model for the append-only WORM pipeline-policy-change log
 * (TASK-356 Phase 5). Although it extends `BaseTenantDataModel`, the backing
 * table has NO `_version` / `_metadata` / `updatedAt` / `createdBy` /
 * `updatedBy` columns — those inherited fields are stripped in
 * `PipelinePolicyChangeEntityMapper` before any write. Only `createdAt`
 * (DB default) is retained from the base. Mirrors `HarnessPolicyChange`.
 */
export class PipelinePolicyChange extends BaseTenantDataModel {
  public scope: Enums.PipelinePolicyScope;
  public scopeId: string | null;
  public changedBy: string | null;
  public policyVersion: number | null;
  public beforeJson: JsonValue | null;
  public afterJson: JsonValue;
  public reason: string | null;

  constructor(data: PipelinePolicyChange & BaseTenantDataModel) {
    super(data);
    this.scope = data.scope;
    this.scopeId = data.scopeId;
    this.changedBy = data.changedBy;
    this.policyVersion = data.policyVersion;
    this.beforeJson = data.beforeJson;
    this.afterJson = data.afterJson;
    this.reason = data.reason;
  }
}
