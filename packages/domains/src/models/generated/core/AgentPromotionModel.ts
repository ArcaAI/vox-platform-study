/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AgentPromotion extends BaseTenantDataModel {
  public fromTenantId: string;
  public toTenantId: string;
  public agentVersionId: string;
  public sourceAgentId: string;
  public targetAgentId: string;
  public targetAgentVersionId: string | null;
  public configSnapshot: JsonValue;
  public checksum: string;
  public evalRunId: string | null;
  public sourceEvalRunId: string | null;
  public warnings: JsonValue | null;
  public promotedBy: string | null;

  constructor(data: AgentPromotion & BaseTenantDataModel) {
    super(data);
    this.fromTenantId = data.fromTenantId;
    this.toTenantId = data.toTenantId;
    this.agentVersionId = data.agentVersionId;
    this.sourceAgentId = data.sourceAgentId;
    this.targetAgentId = data.targetAgentId;
    this.targetAgentVersionId = data.targetAgentVersionId;
    this.configSnapshot = data.configSnapshot;
    this.checksum = data.checksum;
    this.evalRunId = data.evalRunId;
    this.sourceEvalRunId = data.sourceEvalRunId;
    this.warnings = data.warnings;
    this.promotedBy = data.promotedBy;
  }
}
