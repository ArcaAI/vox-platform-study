/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Durable per-AI-activity run record (a transcription session, an NER call, a
 * note-generation call, a sensor, ...). Ids, enums and numbers only — NO free
 * text, no PHI. `runKey` ("<producer>:<sessionId>:<runId>:<seq>") makes the
 * write an idempotent upsert. Append-only telemetry: no `resourceStatus`
 * (never soft-deleted) and not pruned with the trajectory. `contextItemId` +
 * `outputVersionNumber` name the item version the run produced.
 */
export interface IAiActivityRunEntity extends IBaseTenantEntity {
  runKey: string;
  consultationId?: string | null;
  encounterSeq?: number | null;
  activityKind: Enums.AiActivityKind;
  status: Enums.AiActivityRunStatus;
  workflowSlug?: string | null;
  workflowVersion?: number | null;
  workflowRunId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  agentSlug?: string | null;
  agentVersion?: number | null;
  promptTemplateId?: string | null;
  promptVersion?: number | null;
  model?: string | null;
  provider?: string | null;
  deployment?: Enums.AiDeploymentKind | null;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  contextUsed?: number | null;
  contextWindow?: number | null;
  outputCap?: number | null;
  stopReason?: string | null;
  budgetStrategy?: string | null;
  callIndex?: number | null;
  callCount?: number | null;
  costMicros?: bigint | null;
  costBasis?: Enums.AiCostBasis | null;
  usageRequestId?: string | null;
  errorCode?: string | null;
  contextItemId?: string | null;
  outputVersionNumber?: number | null;
}

export class AiActivityRunEntity extends BaseTenantEntity {
  private _metaData?: IAiActivityRunEntity['metaData'];
  private _runKey: IAiActivityRunEntity['runKey'];
  private _consultationId?: IAiActivityRunEntity['consultationId'];
  private _encounterSeq?: IAiActivityRunEntity['encounterSeq'];
  private _activityKind: IAiActivityRunEntity['activityKind'];
  private _status: IAiActivityRunEntity['status'];
  private _workflowSlug?: IAiActivityRunEntity['workflowSlug'];
  private _workflowVersion?: IAiActivityRunEntity['workflowVersion'];
  private _workflowRunId?: IAiActivityRunEntity['workflowRunId'];
  private _nodeId?: IAiActivityRunEntity['nodeId'];
  private _agentId?: IAiActivityRunEntity['agentId'];
  private _agentSlug?: IAiActivityRunEntity['agentSlug'];
  private _agentVersion?: IAiActivityRunEntity['agentVersion'];
  private _promptTemplateId?: IAiActivityRunEntity['promptTemplateId'];
  private _promptVersion?: IAiActivityRunEntity['promptVersion'];
  private _model?: IAiActivityRunEntity['model'];
  private _provider?: IAiActivityRunEntity['provider'];
  private _deployment?: IAiActivityRunEntity['deployment'];
  private _startedAt: IAiActivityRunEntity['startedAt'];
  private _endedAt?: IAiActivityRunEntity['endedAt'];
  private _durationMs?: IAiActivityRunEntity['durationMs'];
  private _tokensIn?: IAiActivityRunEntity['tokensIn'];
  private _tokensOut?: IAiActivityRunEntity['tokensOut'];
  private _contextUsed?: IAiActivityRunEntity['contextUsed'];
  private _contextWindow?: IAiActivityRunEntity['contextWindow'];
  private _outputCap?: IAiActivityRunEntity['outputCap'];
  private _stopReason?: IAiActivityRunEntity['stopReason'];
  private _budgetStrategy?: IAiActivityRunEntity['budgetStrategy'];
  private _callIndex?: IAiActivityRunEntity['callIndex'];
  private _callCount?: IAiActivityRunEntity['callCount'];
  private _costMicros?: IAiActivityRunEntity['costMicros'];
  private _costBasis?: IAiActivityRunEntity['costBasis'];
  private _usageRequestId?: IAiActivityRunEntity['usageRequestId'];
  private _errorCode?: IAiActivityRunEntity['errorCode'];
  private _contextItemId?: IAiActivityRunEntity['contextItemId'];
  private _outputVersionNumber?: IAiActivityRunEntity['outputVersionNumber'];

  constructor(init: IAiActivityRunEntity) {
    super(init);
    this._metaData = init.metaData;
    this._runKey = init.runKey;
    this._consultationId = init.consultationId;
    this._encounterSeq = init.encounterSeq;
    this._activityKind = init.activityKind;
    this._status = init.status;
    this._workflowSlug = init.workflowSlug;
    this._workflowVersion = init.workflowVersion;
    this._workflowRunId = init.workflowRunId;
    this._nodeId = init.nodeId;
    this._agentId = init.agentId;
    this._agentSlug = init.agentSlug;
    this._agentVersion = init.agentVersion;
    this._promptTemplateId = init.promptTemplateId;
    this._promptVersion = init.promptVersion;
    this._model = init.model;
    this._provider = init.provider;
    this._deployment = init.deployment;
    this._startedAt = init.startedAt;
    this._endedAt = init.endedAt;
    this._durationMs = init.durationMs;
    this._tokensIn = init.tokensIn;
    this._tokensOut = init.tokensOut;
    this._contextUsed = init.contextUsed;
    this._contextWindow = init.contextWindow;
    this._outputCap = init.outputCap;
    this._stopReason = init.stopReason;
    this._budgetStrategy = init.budgetStrategy;
    this._callIndex = init.callIndex;
    this._callCount = init.callCount;
    this._costMicros = init.costMicros;
    this._costBasis = init.costBasis;
    this._usageRequestId = init.usageRequestId;
    this._errorCode = init.errorCode;
    this._contextItemId = init.contextItemId;
    this._outputVersionNumber = init.outputVersionNumber;
  }

  get metaData(): IAiActivityRunEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IAiActivityRunEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  get runKey(): IAiActivityRunEntity['runKey'] {
    return this._runKey;
  }

  set runKey(value: IAiActivityRunEntity['runKey']) {
    this.setProperty('runKey', value);
  }

  get consultationId(): IAiActivityRunEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IAiActivityRunEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get encounterSeq(): IAiActivityRunEntity['encounterSeq'] {
    return this._encounterSeq;
  }

  set encounterSeq(value: IAiActivityRunEntity['encounterSeq']) {
    this.setProperty('encounterSeq', value);
  }

  get activityKind(): IAiActivityRunEntity['activityKind'] {
    return this._activityKind;
  }

  set activityKind(value: IAiActivityRunEntity['activityKind']) {
    this.setProperty('activityKind', value);
  }

  get status(): IAiActivityRunEntity['status'] {
    return this._status;
  }

  set status(value: IAiActivityRunEntity['status']) {
    this.setProperty('status', value);
  }

  get workflowSlug(): IAiActivityRunEntity['workflowSlug'] {
    return this._workflowSlug;
  }

  set workflowSlug(value: IAiActivityRunEntity['workflowSlug']) {
    this.setProperty('workflowSlug', value);
  }

  get workflowVersion(): IAiActivityRunEntity['workflowVersion'] {
    return this._workflowVersion;
  }

  set workflowVersion(value: IAiActivityRunEntity['workflowVersion']) {
    this.setProperty('workflowVersion', value);
  }

  get workflowRunId(): IAiActivityRunEntity['workflowRunId'] {
    return this._workflowRunId;
  }

  set workflowRunId(value: IAiActivityRunEntity['workflowRunId']) {
    this.setProperty('workflowRunId', value);
  }

  get nodeId(): IAiActivityRunEntity['nodeId'] {
    return this._nodeId;
  }

  set nodeId(value: IAiActivityRunEntity['nodeId']) {
    this.setProperty('nodeId', value);
  }

  get agentId(): IAiActivityRunEntity['agentId'] {
    return this._agentId;
  }

  set agentId(value: IAiActivityRunEntity['agentId']) {
    this.setProperty('agentId', value);
  }

  get agentSlug(): IAiActivityRunEntity['agentSlug'] {
    return this._agentSlug;
  }

  set agentSlug(value: IAiActivityRunEntity['agentSlug']) {
    this.setProperty('agentSlug', value);
  }

  get agentVersion(): IAiActivityRunEntity['agentVersion'] {
    return this._agentVersion;
  }

  set agentVersion(value: IAiActivityRunEntity['agentVersion']) {
    this.setProperty('agentVersion', value);
  }

  get promptTemplateId(): IAiActivityRunEntity['promptTemplateId'] {
    return this._promptTemplateId;
  }

  set promptTemplateId(value: IAiActivityRunEntity['promptTemplateId']) {
    this.setProperty('promptTemplateId', value);
  }

  get promptVersion(): IAiActivityRunEntity['promptVersion'] {
    return this._promptVersion;
  }

  set promptVersion(value: IAiActivityRunEntity['promptVersion']) {
    this.setProperty('promptVersion', value);
  }

  get model(): IAiActivityRunEntity['model'] {
    return this._model;
  }

  set model(value: IAiActivityRunEntity['model']) {
    this.setProperty('model', value);
  }

  get provider(): IAiActivityRunEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiActivityRunEntity['provider']) {
    this.setProperty('provider', value);
  }

  get deployment(): IAiActivityRunEntity['deployment'] {
    return this._deployment;
  }

  set deployment(value: IAiActivityRunEntity['deployment']) {
    this.setProperty('deployment', value);
  }

  get startedAt(): IAiActivityRunEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: IAiActivityRunEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get endedAt(): IAiActivityRunEntity['endedAt'] {
    return this._endedAt;
  }

  set endedAt(value: IAiActivityRunEntity['endedAt']) {
    this.setProperty('endedAt', value);
  }

  get durationMs(): IAiActivityRunEntity['durationMs'] {
    return this._durationMs;
  }

  set durationMs(value: IAiActivityRunEntity['durationMs']) {
    this.setProperty('durationMs', value);
  }

  get tokensIn(): IAiActivityRunEntity['tokensIn'] {
    return this._tokensIn;
  }

  set tokensIn(value: IAiActivityRunEntity['tokensIn']) {
    this.setProperty('tokensIn', value);
  }

  get tokensOut(): IAiActivityRunEntity['tokensOut'] {
    return this._tokensOut;
  }

  set tokensOut(value: IAiActivityRunEntity['tokensOut']) {
    this.setProperty('tokensOut', value);
  }

  get contextUsed(): IAiActivityRunEntity['contextUsed'] {
    return this._contextUsed;
  }

  set contextUsed(value: IAiActivityRunEntity['contextUsed']) {
    this.setProperty('contextUsed', value);
  }

  get contextWindow(): IAiActivityRunEntity['contextWindow'] {
    return this._contextWindow;
  }

  set contextWindow(value: IAiActivityRunEntity['contextWindow']) {
    this.setProperty('contextWindow', value);
  }

  get outputCap(): IAiActivityRunEntity['outputCap'] {
    return this._outputCap;
  }

  set outputCap(value: IAiActivityRunEntity['outputCap']) {
    this.setProperty('outputCap', value);
  }

  get stopReason(): IAiActivityRunEntity['stopReason'] {
    return this._stopReason;
  }

  set stopReason(value: IAiActivityRunEntity['stopReason']) {
    this.setProperty('stopReason', value);
  }

  get budgetStrategy(): IAiActivityRunEntity['budgetStrategy'] {
    return this._budgetStrategy;
  }

  set budgetStrategy(value: IAiActivityRunEntity['budgetStrategy']) {
    this.setProperty('budgetStrategy', value);
  }

  get callIndex(): IAiActivityRunEntity['callIndex'] {
    return this._callIndex;
  }

  set callIndex(value: IAiActivityRunEntity['callIndex']) {
    this.setProperty('callIndex', value);
  }

  get callCount(): IAiActivityRunEntity['callCount'] {
    return this._callCount;
  }

  set callCount(value: IAiActivityRunEntity['callCount']) {
    this.setProperty('callCount', value);
  }

  get costMicros(): IAiActivityRunEntity['costMicros'] {
    return this._costMicros;
  }

  set costMicros(value: IAiActivityRunEntity['costMicros']) {
    this.setProperty('costMicros', value);
  }

  get costBasis(): IAiActivityRunEntity['costBasis'] {
    return this._costBasis;
  }

  set costBasis(value: IAiActivityRunEntity['costBasis']) {
    this.setProperty('costBasis', value);
  }

  get usageRequestId(): IAiActivityRunEntity['usageRequestId'] {
    return this._usageRequestId;
  }

  set usageRequestId(value: IAiActivityRunEntity['usageRequestId']) {
    this.setProperty('usageRequestId', value);
  }

  get errorCode(): IAiActivityRunEntity['errorCode'] {
    return this._errorCode;
  }

  set errorCode(value: IAiActivityRunEntity['errorCode']) {
    this.setProperty('errorCode', value);
  }

  get contextItemId(): IAiActivityRunEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: IAiActivityRunEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get outputVersionNumber(): IAiActivityRunEntity['outputVersionNumber'] {
    return this._outputVersionNumber;
  }

  set outputVersionNumber(value: IAiActivityRunEntity['outputVersionNumber']) {
    this.setProperty('outputVersionNumber', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._runKey) {
      throw new BusinessException('Run key is required');
    }
    if (!this._startedAt) {
      throw new BusinessException('startedAt is required');
    }
  }
}
