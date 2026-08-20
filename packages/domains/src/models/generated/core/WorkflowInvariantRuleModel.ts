/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class WorkflowInvariantRule extends BaseTenantDataModel {
  public ruleId: string;
  public registerRefs: string[];
  public title: string;
  public rationale: string | null;
  public predicateType: Enums.WorkflowRulePredicateType;
  public predicateConfig: JsonValue;
  public paletteKey: string | null;
  public severity: Enums.WorkflowRuleSeverity;
  public ruleVersion: number;
  public effectiveFrom: Date;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: WorkflowInvariantRule & BaseTenantDataModel) {
    super(data);
    this.ruleId = data.ruleId;
    this.registerRefs = data.registerRefs;
    this.title = data.title;
    this.rationale = data.rationale;
    this.predicateType = data.predicateType;
    this.predicateConfig = data.predicateConfig;
    this.paletteKey = data.paletteKey;
    this.severity = data.severity;
    this.ruleVersion = data.ruleVersion;
    this.effectiveFrom = data.effectiveFrom;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
