/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Ordered, typed, per-session trajectory step (TASK-510 Phase 2A).
 *
 * A tenant-scoped OPERATIONAL TELEMETRY row: every AI working session
 * (live-doc / harness / summary job / eval run) emits an ordered sequence of
 * typed steps. INTENTIONAL posture (differs from clinical models):
 *   - NO soft-delete: hard retention (nightly prune) — the entity is listed in
 *     MODELS_WITHOUT_SOFT_DELETE and the table carries no `resourceStatus`
 *     column; `softDelete()`/`restore()` throw for this repository.
 *   - NO sys-events on write: the trajectory IS the event stream, so emitting a
 *     sys-event per step would be circular.
 *   - Stats-first / payload-by-reference: `stats` carries the AD-1
 *     GenerationStats on LLM_CALL steps; `payloadRef` holds only a claim-check
 *     ref / encrypted pointer — never plaintext clinical content.
 * `_version` (OCC) + `_metadata` + standard audit fields are retained so the
 * row still round-trips through the shared BaseTenantEntity / Repository
 * machinery.
 */
export interface IAgentTrajectoryStepEntity extends IBaseTenantEntity {
  consultationId?: string | null;
  sessionKind: Enums.AgentSessionKind;
  sessionId: string;
  // Non-null "" sentinel for non-Temporal sessions (see the prisma model) — the
  // composite unique idempotency depends on runId never being null.
  runId: string;
  seq: number;
  stepType: Enums.AgentStepType;
  name: string;
  status: Enums.AgentStepStatus;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  stats?: JsonValue | null;
  payloadRef?: JsonValue | null;
  errorCode?: string | null;
  correlationId?: string | null;
}

export class AgentTrajectoryStepEntity extends BaseTenantEntity {
  private _consultationId?: IAgentTrajectoryStepEntity['consultationId'];
  private _sessionKind: IAgentTrajectoryStepEntity['sessionKind'];
  private _sessionId: IAgentTrajectoryStepEntity['sessionId'];
  private _runId?: IAgentTrajectoryStepEntity['runId'];
  private _seq: IAgentTrajectoryStepEntity['seq'];
  private _stepType: IAgentTrajectoryStepEntity['stepType'];
  private _name: IAgentTrajectoryStepEntity['name'];
  private _status: IAgentTrajectoryStepEntity['status'];
  private _startedAt: IAgentTrajectoryStepEntity['startedAt'];
  private _endedAt?: IAgentTrajectoryStepEntity['endedAt'];
  private _durationMs?: IAgentTrajectoryStepEntity['durationMs'];
  private _stats?: IAgentTrajectoryStepEntity['stats'];
  private _payloadRef?: IAgentTrajectoryStepEntity['payloadRef'];
  private _errorCode?: IAgentTrajectoryStepEntity['errorCode'];
  private _correlationId?: IAgentTrajectoryStepEntity['correlationId'];

  constructor(init: IAgentTrajectoryStepEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._sessionKind = init.sessionKind;
    this._sessionId = init.sessionId;
    this._runId = init.runId;
    this._seq = init.seq;
    this._stepType = init.stepType;
    this._name = init.name;
    this._status = init.status;
    this._startedAt = init.startedAt;
    this._endedAt = init.endedAt;
    this._durationMs = init.durationMs;
    this._stats = init.stats;
    this._payloadRef = init.payloadRef;
    this._errorCode = init.errorCode;
    this._correlationId = init.correlationId;
  }

  get consultationId(): IAgentTrajectoryStepEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IAgentTrajectoryStepEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get sessionKind(): IAgentTrajectoryStepEntity['sessionKind'] {
    return this._sessionKind;
  }

  set sessionKind(value: IAgentTrajectoryStepEntity['sessionKind']) {
    this.setProperty('sessionKind', value);
  }

  get sessionId(): IAgentTrajectoryStepEntity['sessionId'] {
    return this._sessionId;
  }

  set sessionId(value: IAgentTrajectoryStepEntity['sessionId']) {
    this.setProperty('sessionId', value);
  }

  get runId(): IAgentTrajectoryStepEntity['runId'] {
    return this._runId;
  }

  set runId(value: IAgentTrajectoryStepEntity['runId']) {
    this.setProperty('runId', value);
  }

  get seq(): IAgentTrajectoryStepEntity['seq'] {
    return this._seq;
  }

  set seq(value: IAgentTrajectoryStepEntity['seq']) {
    this.setProperty('seq', value);
  }

  get stepType(): IAgentTrajectoryStepEntity['stepType'] {
    return this._stepType;
  }

  set stepType(value: IAgentTrajectoryStepEntity['stepType']) {
    this.setProperty('stepType', value);
  }

  get name(): IAgentTrajectoryStepEntity['name'] {
    return this._name;
  }

  set name(value: IAgentTrajectoryStepEntity['name']) {
    this.setProperty('name', value);
  }

  get status(): IAgentTrajectoryStepEntity['status'] {
    return this._status;
  }

  set status(value: IAgentTrajectoryStepEntity['status']) {
    this.setProperty('status', value);
  }

  get startedAt(): IAgentTrajectoryStepEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: IAgentTrajectoryStepEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get endedAt(): IAgentTrajectoryStepEntity['endedAt'] {
    return this._endedAt;
  }

  set endedAt(value: IAgentTrajectoryStepEntity['endedAt']) {
    this.setProperty('endedAt', value);
  }

  get durationMs(): IAgentTrajectoryStepEntity['durationMs'] {
    return this._durationMs;
  }

  set durationMs(value: IAgentTrajectoryStepEntity['durationMs']) {
    this.setProperty('durationMs', value);
  }

  // `stats` is aggregate GenerationStats (non-PHI token counts / timings) — safe
  // in audit surfaces, so it is NOT marked @Secret(). Only `payloadRef` (which
  // may reference session working data) is redacted.
  get stats(): IAgentTrajectoryStepEntity['stats'] {
    return this._stats;
  }

  set stats(value: IAgentTrajectoryStepEntity['stats']) {
    this.setProperty('stats', value);
  }

  @Secret()
  get payloadRef(): IAgentTrajectoryStepEntity['payloadRef'] {
    return this._payloadRef;
  }

  set payloadRef(value: IAgentTrajectoryStepEntity['payloadRef']) {
    this.setProperty('payloadRef', value);
  }

  get errorCode(): IAgentTrajectoryStepEntity['errorCode'] {
    return this._errorCode;
  }

  set errorCode(value: IAgentTrajectoryStepEntity['errorCode']) {
    this.setProperty('errorCode', value);
  }

  get correlationId(): IAgentTrajectoryStepEntity['correlationId'] {
    return this._correlationId;
  }

  set correlationId(value: IAgentTrajectoryStepEntity['correlationId']) {
    this.setProperty('correlationId', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._sessionId || this._sessionId.trim().length === 0) {
      throw new BusinessException('AgentTrajectoryStep sessionId is required.');
    }
    if (this._seq === undefined || this._seq === null) {
      throw new BusinessException('AgentTrajectoryStep seq is required.');
    }
    if (this._sessionKind === undefined || this._sessionKind === null) {
      throw new BusinessException('AgentTrajectoryStep sessionKind is required.');
    }
    if (this._stepType === undefined || this._stepType === null) {
      throw new BusinessException('AgentTrajectoryStep stepType is required.');
    }
    if (this._status === undefined || this._status === null) {
      throw new BusinessException('AgentTrajectoryStep status is required.');
    }
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('AgentTrajectoryStep name is required.');
    }
  }
}
