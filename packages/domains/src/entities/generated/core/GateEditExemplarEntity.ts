import { BusinessException } from '@arcaai/exceptions';

import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

/**
 * TASK-533 B6 (§3.4) — the mined clinician signal.
 *
 * `APPROVED_CLEAN` = the gate output was signed with little or no editing (a
 * positive exemplar). `HEAVILY_EDITED` = the clinician substantially rewrote it
 * (a negative exemplar / regression candidate). Retrieval ranks on this label,
 * so it is a closed set rather than free text.
 */
export const GATE_EDIT_QUALITY_SIGNALS = ['APPROVED_CLEAN', 'HEAVILY_EDITED'] as const;
export type GateEditQualitySignal = (typeof GATE_EDIT_QUALITY_SIGNALS)[number];

export interface IGateEditExemplarEntity extends IBaseTenantEntity {
  consultationId: string;
  departmentId?: string | null;
  visitType?: string | null;
  gateDecision: string;
  qualitySignal: string;
  editDistance?: number | null;
  editDistanceRatio?: number | null;
  timeToSignSeconds?: number | null;
  redactedBefore?: string | null;
  redactedAfter?: string | null;
  contextItemId?: string | null;
  modelName?: string | null;
  promptTemplateId?: string | null;
}

export class GateEditExemplarEntity extends BaseTenantEntity {
  private _consultationId: IGateEditExemplarEntity['consultationId'];
  private _departmentId?: IGateEditExemplarEntity['departmentId'];
  private _visitType?: IGateEditExemplarEntity['visitType'];
  private _gateDecision: IGateEditExemplarEntity['gateDecision'];
  private _qualitySignal: IGateEditExemplarEntity['qualitySignal'];
  private _editDistance?: IGateEditExemplarEntity['editDistance'];
  private _editDistanceRatio?: IGateEditExemplarEntity['editDistanceRatio'];
  private _timeToSignSeconds?: IGateEditExemplarEntity['timeToSignSeconds'];
  private _redactedBefore?: IGateEditExemplarEntity['redactedBefore'];
  private _redactedAfter?: IGateEditExemplarEntity['redactedAfter'];
  private _contextItemId?: IGateEditExemplarEntity['contextItemId'];
  private _modelName?: IGateEditExemplarEntity['modelName'];
  private _promptTemplateId?: IGateEditExemplarEntity['promptTemplateId'];

  constructor(init: IGateEditExemplarEntity) {
    super(init);
    this._consultationId = init.consultationId;
    this._departmentId = init.departmentId;
    this._visitType = init.visitType;
    this._gateDecision = init.gateDecision;
    this._qualitySignal = init.qualitySignal;
    this._editDistance = init.editDistance;
    this._editDistanceRatio = init.editDistanceRatio;
    this._timeToSignSeconds = init.timeToSignSeconds;
    this._redactedBefore = init.redactedBefore;
    this._redactedAfter = init.redactedAfter;
    this._contextItemId = init.contextItemId;
    this._modelName = init.modelName;
    this._promptTemplateId = init.promptTemplateId;
  }

  public get consultationId(): IGateEditExemplarEntity['consultationId'] {
    return this._consultationId;
  }

  public set consultationId(value: IGateEditExemplarEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  public get departmentId(): IGateEditExemplarEntity['departmentId'] {
    return this._departmentId;
  }

  public set departmentId(value: IGateEditExemplarEntity['departmentId']) {
    this.setProperty('departmentId', value);
  }

  public get visitType(): IGateEditExemplarEntity['visitType'] {
    return this._visitType;
  }

  public set visitType(value: IGateEditExemplarEntity['visitType']) {
    this.setProperty('visitType', value);
  }

  public get gateDecision(): IGateEditExemplarEntity['gateDecision'] {
    return this._gateDecision;
  }

  public set gateDecision(value: IGateEditExemplarEntity['gateDecision']) {
    this.setProperty('gateDecision', value);
  }

  public get qualitySignal(): IGateEditExemplarEntity['qualitySignal'] {
    return this._qualitySignal;
  }

  public set qualitySignal(value: IGateEditExemplarEntity['qualitySignal']) {
    this.setProperty('qualitySignal', value);
  }

  public get editDistance(): IGateEditExemplarEntity['editDistance'] {
    return this._editDistance;
  }

  public set editDistance(value: IGateEditExemplarEntity['editDistance']) {
    this.setProperty('editDistance', value);
  }

  public get editDistanceRatio(): IGateEditExemplarEntity['editDistanceRatio'] {
    return this._editDistanceRatio;
  }

  public set editDistanceRatio(value: IGateEditExemplarEntity['editDistanceRatio']) {
    this.setProperty('editDistanceRatio', value);
  }

  public get timeToSignSeconds(): IGateEditExemplarEntity['timeToSignSeconds'] {
    return this._timeToSignSeconds;
  }

  public set timeToSignSeconds(value: IGateEditExemplarEntity['timeToSignSeconds']) {
    this.setProperty('timeToSignSeconds', value);
  }

  public get redactedBefore(): IGateEditExemplarEntity['redactedBefore'] {
    return this._redactedBefore;
  }

  public set redactedBefore(value: IGateEditExemplarEntity['redactedBefore']) {
    this.setProperty('redactedBefore', value);
  }

  public get redactedAfter(): IGateEditExemplarEntity['redactedAfter'] {
    return this._redactedAfter;
  }

  public set redactedAfter(value: IGateEditExemplarEntity['redactedAfter']) {
    this.setProperty('redactedAfter', value);
  }

  public get contextItemId(): IGateEditExemplarEntity['contextItemId'] {
    return this._contextItemId;
  }

  public set contextItemId(value: IGateEditExemplarEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  public get modelName(): IGateEditExemplarEntity['modelName'] {
    return this._modelName;
  }

  public set modelName(value: IGateEditExemplarEntity['modelName']) {
    this.setProperty('modelName', value);
  }

  public get promptTemplateId(): IGateEditExemplarEntity['promptTemplateId'] {
    return this._promptTemplateId;
  }

  public set promptTemplateId(value: IGateEditExemplarEntity['promptTemplateId']) {
    this.setProperty('promptTemplateId', value);
  }

  public validate(): void {
    super.validate();

    if (!this._consultationId || this._consultationId.trim().length === 0) {
      throw new BusinessException('Consultation id is required');
    }

    if (!this._gateDecision || this._gateDecision.trim().length === 0) {
      throw new BusinessException('Gate decision is required');
    }

    if (!GATE_EDIT_QUALITY_SIGNALS.includes(this._qualitySignal as GateEditQualitySignal)) {
      throw new BusinessException(`Quality signal must be one of ${GATE_EDIT_QUALITY_SIGNALS.join(', ')}`);
    }

    if (this._editDistanceRatio !== null && this._editDistanceRatio !== undefined) {
      if (this._editDistanceRatio < 0 || this._editDistanceRatio > 1) {
        throw new BusinessException('Edit distance ratio must be a fraction in [0,1]');
      }
    }
  }
}
