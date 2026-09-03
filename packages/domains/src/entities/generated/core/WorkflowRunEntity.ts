/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * The runs/observability read model — one row per workflow-substrate run.
 *
 * A tenant-scoped OPERATIONAL TELEMETRY row, the same posture as
 * AgentTrajectoryStep (see that entity's header):
 *   - NO soft-delete: the entity is listed in MODELS_WITHOUT_SOFT_DELETE and the
 *     table carries no `resourceStatus` column; `softDelete()`/`restore()`
 *     throw for this repository.
 *   - NO sys-events on write: `recordRunStarted`/`recordRunFinished` are the
 * write contract (called by dispatcher or a future gateway
 *     controller — see the ticket's R2), and emit nothing.
 *   - `status` deliberately has NO `DEGRADED` member — degradation is the
 *     `degradedNodeCount` flag, never a run STATE (README pitfall 6).
 * `_version` (OCC) + `_metadata` + standard audit fields are retained so the
 * row still round-trips through the shared BaseTenantEntity / Repository
 * machinery, exactly like AgentTrajectoryStep.
 */
export interface IWorkflowRunEntity extends IBaseTenantEntity {
  workflowVersionId: string;
  workflowSlug: string;
  workflowVersionNumber: number;
  definitionName: string;
  sessionId: string;
  // Non-null "" sentinel, mirroring AgentTrajectoryStep.runId — the composite
  // unique idempotency on (tenantId, sessionId, runId) depends on this never
  // being null.
  runId: string;
  trigger: string;
  status: Enums.WorkflowRunStatus;
  isSandbox: boolean;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  nodeCount?: number | null;
  failedNodeCount: number;
  degradedNodeCount: number;
  firstErrorCode?: string | null;
  /**
* (M-2) — the run's delivered output, stored verbatim from the
   *  `output.deliver` node: `{ resultRef: ClaimCheckRef }` when offloaded to
   *  claim-check storage, or `{ outputs: {...} }` inline. Null while RUNNING and
   *  for any graph with no `output.deliver` node. 
 */
  resultRef?: JsonValue | null;
}

export class WorkflowRunEntity extends BaseTenantEntity {
  private _workflowVersionId: IWorkflowRunEntity['workflowVersionId'];
  private _workflowSlug: IWorkflowRunEntity['workflowSlug'];
  private _workflowVersionNumber: IWorkflowRunEntity['workflowVersionNumber'];
  private _definitionName: IWorkflowRunEntity['definitionName'];
  private _sessionId: IWorkflowRunEntity['sessionId'];
  private _runId: IWorkflowRunEntity['runId'];
  private _trigger: IWorkflowRunEntity['trigger'];
  private _status: IWorkflowRunEntity['status'];
  private _isSandbox: IWorkflowRunEntity['isSandbox'];
  private _startedAt: IWorkflowRunEntity['startedAt'];
  private _endedAt?: IWorkflowRunEntity['endedAt'];
  private _durationMs?: IWorkflowRunEntity['durationMs'];
  private _nodeCount?: IWorkflowRunEntity['nodeCount'];
  private _failedNodeCount: IWorkflowRunEntity['failedNodeCount'];
  private _degradedNodeCount: IWorkflowRunEntity['degradedNodeCount'];
  private _firstErrorCode?: IWorkflowRunEntity['firstErrorCode'];
  private _resultRef?: IWorkflowRunEntity['resultRef'];

  constructor(init: IWorkflowRunEntity) {
    super(init);
    this._workflowVersionId = init.workflowVersionId;
    this._workflowSlug = init.workflowSlug;
    this._workflowVersionNumber = init.workflowVersionNumber;
    this._definitionName = init.definitionName;
    this._sessionId = init.sessionId;
    this._runId = init.runId;
    this._trigger = init.trigger;
    this._status = init.status;
    this._isSandbox = init.isSandbox;
    this._startedAt = init.startedAt;
    this._endedAt = init.endedAt;
    this._durationMs = init.durationMs;
    this._nodeCount = init.nodeCount;
    this._failedNodeCount = init.failedNodeCount;
    this._degradedNodeCount = init.degradedNodeCount;
    this._firstErrorCode = init.firstErrorCode;
    this._resultRef = init.resultRef;
  }

  get workflowVersionId(): IWorkflowRunEntity['workflowVersionId'] {
    return this._workflowVersionId;
  }

  set workflowVersionId(value: IWorkflowRunEntity['workflowVersionId']) {
    this.setProperty('workflowVersionId', value);
  }

  get workflowSlug(): IWorkflowRunEntity['workflowSlug'] {
    return this._workflowSlug;
  }

  set workflowSlug(value: IWorkflowRunEntity['workflowSlug']) {
    this.setProperty('workflowSlug', value);
  }

  get workflowVersionNumber(): IWorkflowRunEntity['workflowVersionNumber'] {
    return this._workflowVersionNumber;
  }

  set workflowVersionNumber(value: IWorkflowRunEntity['workflowVersionNumber']) {
    this.setProperty('workflowVersionNumber', value);
  }

  get definitionName(): IWorkflowRunEntity['definitionName'] {
    return this._definitionName;
  }

  set definitionName(value: IWorkflowRunEntity['definitionName']) {
    this.setProperty('definitionName', value);
  }

  get sessionId(): IWorkflowRunEntity['sessionId'] {
    return this._sessionId;
  }

  set sessionId(value: IWorkflowRunEntity['sessionId']) {
    this.setProperty('sessionId', value);
  }

  get runId(): IWorkflowRunEntity['runId'] {
    return this._runId;
  }

  set runId(value: IWorkflowRunEntity['runId']) {
    this.setProperty('runId', value);
  }

  get trigger(): IWorkflowRunEntity['trigger'] {
    return this._trigger;
  }

  set trigger(value: IWorkflowRunEntity['trigger']) {
    this.setProperty('trigger', value);
  }

  get status(): IWorkflowRunEntity['status'] {
    return this._status;
  }

  set status(value: IWorkflowRunEntity['status']) {
    this.setProperty('status', value);
  }

  get isSandbox(): IWorkflowRunEntity['isSandbox'] {
    return this._isSandbox;
  }

  set isSandbox(value: IWorkflowRunEntity['isSandbox']) {
    this.setProperty('isSandbox', value);
  }

  get startedAt(): IWorkflowRunEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: IWorkflowRunEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get endedAt(): IWorkflowRunEntity['endedAt'] {
    return this._endedAt;
  }

  set endedAt(value: IWorkflowRunEntity['endedAt']) {
    this.setProperty('endedAt', value);
  }

  get durationMs(): IWorkflowRunEntity['durationMs'] {
    return this._durationMs;
  }

  set durationMs(value: IWorkflowRunEntity['durationMs']) {
    this.setProperty('durationMs', value);
  }

  get nodeCount(): IWorkflowRunEntity['nodeCount'] {
    return this._nodeCount;
  }

  set nodeCount(value: IWorkflowRunEntity['nodeCount']) {
    this.setProperty('nodeCount', value);
  }

  get failedNodeCount(): IWorkflowRunEntity['failedNodeCount'] {
    return this._failedNodeCount;
  }

  set failedNodeCount(value: IWorkflowRunEntity['failedNodeCount']) {
    this.setProperty('failedNodeCount', value);
  }

  get degradedNodeCount(): IWorkflowRunEntity['degradedNodeCount'] {
    return this._degradedNodeCount;
  }

  set degradedNodeCount(value: IWorkflowRunEntity['degradedNodeCount']) {
    this.setProperty('degradedNodeCount', value);
  }

  get firstErrorCode(): IWorkflowRunEntity['firstErrorCode'] {
    return this._firstErrorCode;
  }

  set firstErrorCode(value: IWorkflowRunEntity['firstErrorCode']) {
    this.setProperty('firstErrorCode', value);
  }

  get resultRef(): IWorkflowRunEntity['resultRef'] {
    return this._resultRef;
  }

  set resultRef(value: IWorkflowRunEntity['resultRef']) {
    this.setProperty('resultRef', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._sessionId || this._sessionId.trim().length === 0) {
      throw new BusinessException('WorkflowRun sessionId is required.');
    }
    if (!this._workflowVersionId || this._workflowVersionId.trim().length === 0) {
      throw new BusinessException('WorkflowRun workflowVersionId is required.');
    }
    if (!this._workflowSlug || this._workflowSlug.trim().length === 0) {
      throw new BusinessException('WorkflowRun workflowSlug is required.');
    }
    if (this._status === undefined || this._status === null) {
      throw new BusinessException('WorkflowRun status is required.');
    }
    if (!this._startedAt) {
      throw new BusinessException('WorkflowRun startedAt is required.');
    }
  }
}
