/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

/**
 * Persistence model for the editable, tenant-scoped harness runtime policy
 * (TASK-330 Phase 6). Standard model — carries the inherited `_version` OCC
 * token + `resourceStatus` audit fields. Column values mirror the harness
 * runtime defaults (sensors/config.py + core/config.py) so a freshly-created
 * row is a faithful snapshot of the code defaults.
 */
export class HarnessPolicy extends BaseTenantDataModel {
  public entityFaithfulnessThreshold: number;
  public coverageThreshold: number;
  public citationPresenceThreshold: number;
  public numericDoseThreshold: number;
  public groundednessThreshold: number;
  public safetyEnabled: boolean;
  public phiEnabled: boolean;
  public phiFailClosed: boolean;
  public safetyProvider: string;
  public safetyModel: string;
  public smrProvider: string | null;
  public smrModel: string | null;
  public maxRegen: number;
  public gateSlaSeconds: number;
  public gateEscalationSeconds: number;
  public toolAllowlist: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: HarnessPolicy & BaseTenantDataModel) {
    super(data);
    this.entityFaithfulnessThreshold = data.entityFaithfulnessThreshold;
    this.coverageThreshold = data.coverageThreshold;
    this.citationPresenceThreshold = data.citationPresenceThreshold;
    this.numericDoseThreshold = data.numericDoseThreshold;
    this.groundednessThreshold = data.groundednessThreshold;
    this.safetyEnabled = data.safetyEnabled;
    this.phiEnabled = data.phiEnabled;
    this.phiFailClosed = data.phiFailClosed;
    this.safetyProvider = data.safetyProvider;
    this.safetyModel = data.safetyModel;
    this.smrProvider = data.smrProvider;
    this.smrModel = data.smrModel;
    this.maxRegen = data.maxRegen;
    this.gateSlaSeconds = data.gateSlaSeconds;
    this.gateEscalationSeconds = data.gateEscalationSeconds;
    this.toolAllowlist = data.toolAllowlist;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
