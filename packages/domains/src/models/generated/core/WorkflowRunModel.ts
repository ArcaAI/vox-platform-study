/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class WorkflowRun extends BaseTenantDataModel {
  public workflowVersionId: string;
  public workflowSlug: string;
  public workflowVersionNumber: number;
  public definitionName: string;
  public sessionId: string;
  public runId: string;
  public trigger: string;
  public status: Enums.WorkflowRunStatus;
  public isSandbox: boolean;
  public startedAt: Date;
  public endedAt: Date | null;
  public durationMs: number | null;
  public nodeCount: number | null;
  public failedNodeCount: number;
  public degradedNodeCount: number;
  public firstErrorCode: string | null;
  public resultRef: JsonValue | null;

  constructor(data: WorkflowRun & BaseTenantDataModel) {
    super(data);
    this.workflowVersionId = data.workflowVersionId;
    this.workflowSlug = data.workflowSlug;
    this.workflowVersionNumber = data.workflowVersionNumber;
    this.definitionName = data.definitionName;
    this.sessionId = data.sessionId;
    this.runId = data.runId;
    this.trigger = data.trigger;
    this.status = data.status;
    this.isSandbox = data.isSandbox;
    this.startedAt = data.startedAt;
    this.endedAt = data.endedAt;
    this.durationMs = data.durationMs;
    this.nodeCount = data.nodeCount;
    this.failedNodeCount = data.failedNodeCount;
    this.degradedNodeCount = data.degradedNodeCount;
    this.firstErrorCode = data.firstErrorCode;
    this.resultRef = data.resultRef;
  }
}
