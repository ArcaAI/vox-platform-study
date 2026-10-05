/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiActivityRun extends BaseTenantDataModel {
  public runKey: string;
  public consultationId: string | null;
  public encounterSeq: number | null;
  public activityKind: Enums.AiActivityKind;
  public status: Enums.AiActivityRunStatus;
  public workflowSlug: string | null;
  public workflowVersion: number | null;
  public workflowRunId: string | null;
  public nodeId: string | null;
  public agentId: string | null;
  public agentSlug: string | null;
  public agentVersion: number | null;
  public promptTemplateId: string | null;
  public promptVersion: number | null;
  public model: string | null;
  public provider: string | null;
  public deployment: Enums.AiDeploymentKind | null;
  public startedAt: Date;
  public endedAt: Date | null;
  public durationMs: number | null;
  public tokensIn: number | null;
  public tokensOut: number | null;
  public contextUsed: number | null;
  public contextWindow: number | null;
  public outputCap: number | null;
  public stopReason: string | null;
  public budgetStrategy: string | null;
  public callIndex: number | null;
  public callCount: number | null;
  public costMicros: bigint | null;
  public costBasis: Enums.AiCostBasis | null;
  public usageRequestId: string | null;
  public errorCode: string | null;
  public contextItemId: string | null;
  public outputVersionNumber: number | null;

  constructor(data: AiActivityRun & BaseTenantDataModel) {
    super(data);
    this.runKey = data.runKey;
    this.consultationId = data.consultationId;
    this.encounterSeq = data.encounterSeq;
    this.activityKind = data.activityKind;
    this.status = data.status;
    this.workflowSlug = data.workflowSlug;
    this.workflowVersion = data.workflowVersion;
    this.workflowRunId = data.workflowRunId;
    this.nodeId = data.nodeId;
    this.agentId = data.agentId;
    this.agentSlug = data.agentSlug;
    this.agentVersion = data.agentVersion;
    this.promptTemplateId = data.promptTemplateId;
    this.promptVersion = data.promptVersion;
    this.model = data.model;
    this.provider = data.provider;
    this.deployment = data.deployment;
    this.startedAt = data.startedAt;
    this.endedAt = data.endedAt;
    this.durationMs = data.durationMs;
    this.tokensIn = data.tokensIn;
    this.tokensOut = data.tokensOut;
    this.contextUsed = data.contextUsed;
    this.contextWindow = data.contextWindow;
    this.outputCap = data.outputCap;
    this.stopReason = data.stopReason;
    this.budgetStrategy = data.budgetStrategy;
    this.callIndex = data.callIndex;
    this.callCount = data.callCount;
    this.costMicros = data.costMicros;
    this.costBasis = data.costBasis;
    this.usageRequestId = data.usageRequestId;
    this.errorCode = data.errorCode;
    this.contextItemId = data.contextItemId;
    this.outputVersionNumber = data.outputVersionNumber;
  }
}
