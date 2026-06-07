/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

/**
 * Persistence model for the append-only WORM policy-change log (TASK-330
 * Phase 6). Although it extends `BaseTenantDataModel`, the backing table has
 * NO `_version` / `_metadata` / `updatedAt` / `createdBy` / `updatedBy`
 * columns — those inherited fields are stripped in
 * `HarnessPolicyChangeEntityMapper` before any write. Only `createdAt`
 * (DB default) is retained from the base. Mirrors `HarnessAuditEvent`.
 */
export class HarnessPolicyChange extends BaseTenantDataModel {
  public changedBy: string | null;
  public policyVersion: number | null;
  public beforeJson: JsonValue | null;
  public afterJson: JsonValue;
  public reason: string | null;

  constructor(data: HarnessPolicyChange & BaseTenantDataModel) {
    super(data);
    this.changedBy = data.changedBy;
    this.policyVersion = data.policyVersion;
    this.beforeJson = data.beforeJson;
    this.afterJson = data.afterJson;
    this.reason = data.reason;
  }
}
