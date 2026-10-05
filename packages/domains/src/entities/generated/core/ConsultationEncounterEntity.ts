/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * One encounter (visit) of a consultation. `seq` starts at 1 and
 * `Consultation.currentEncounterSeq` names the open one; `externalRef` is the
 * caller's own id for the visit (an EMR event id), unique within the
 * consultation. `recordingStartMs` / `recordingEndMs` place the encounter on
 * the consultation-wide recording timeline. No soft delete: an encounter
 * lives and dies with its consultation.
 */
export interface IConsultationEncounterEntity extends IBaseTenantEntity {
  consultationId: string;
  seq: number;
  visitType: string;
  externalRef?: string | null;
  startedAt: Date;
  endedAt?: Date | null;
  recordingStartMs?: number | null;
  recordingEndMs?: number | null;
  Consultation?: Entities.ConsultationEntity | null;
}

export class ConsultationEncounterEntity extends BaseTenantEntity {
  private _metaData?: IConsultationEncounterEntity['metaData'];
  private _consultationId: IConsultationEncounterEntity['consultationId'];
  private _seq: IConsultationEncounterEntity['seq'];
  private _visitType: IConsultationEncounterEntity['visitType'];
  private _externalRef?: IConsultationEncounterEntity['externalRef'];
  private _startedAt: IConsultationEncounterEntity['startedAt'];
  private _endedAt?: IConsultationEncounterEntity['endedAt'];
  private _recordingStartMs?: IConsultationEncounterEntity['recordingStartMs'];
  private _recordingEndMs?: IConsultationEncounterEntity['recordingEndMs'];
  private _Consultation?: IConsultationEncounterEntity['Consultation'];

  constructor(init: IConsultationEncounterEntity) {
    super(init);
    this._metaData = init.metaData;
    this._consultationId = init.consultationId;
    this._seq = init.seq;
    this._visitType = init.visitType;
    this._externalRef = init.externalRef;
    this._startedAt = init.startedAt;
    this._endedAt = init.endedAt;
    this._recordingStartMs = init.recordingStartMs;
    this._recordingEndMs = init.recordingEndMs;
    this._Consultation = init.Consultation;
  }

  get metaData(): IConsultationEncounterEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IConsultationEncounterEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  get consultationId(): IConsultationEncounterEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IConsultationEncounterEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get seq(): IConsultationEncounterEntity['seq'] {
    return this._seq;
  }

  set seq(value: IConsultationEncounterEntity['seq']) {
    this.setProperty('seq', value);
  }

  get visitType(): IConsultationEncounterEntity['visitType'] {
    return this._visitType;
  }

  set visitType(value: IConsultationEncounterEntity['visitType']) {
    this.setProperty('visitType', value);
  }

  get externalRef(): IConsultationEncounterEntity['externalRef'] {
    return this._externalRef;
  }

  set externalRef(value: IConsultationEncounterEntity['externalRef']) {
    this.setProperty('externalRef', value);
  }

  get startedAt(): IConsultationEncounterEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: IConsultationEncounterEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get endedAt(): IConsultationEncounterEntity['endedAt'] {
    return this._endedAt;
  }

  set endedAt(value: IConsultationEncounterEntity['endedAt']) {
    this.setProperty('endedAt', value);
  }

  get recordingStartMs(): IConsultationEncounterEntity['recordingStartMs'] {
    return this._recordingStartMs;
  }

  set recordingStartMs(value: IConsultationEncounterEntity['recordingStartMs']) {
    this.setProperty('recordingStartMs', value);
  }

  get recordingEndMs(): IConsultationEncounterEntity['recordingEndMs'] {
    return this._recordingEndMs;
  }

  set recordingEndMs(value: IConsultationEncounterEntity['recordingEndMs']) {
    this.setProperty('recordingEndMs', value);
  }

  get Consultation(): IConsultationEncounterEntity['Consultation'] {
    return this._Consultation;
  }

  set Consultation(value: IConsultationEncounterEntity['Consultation']) {
    this.setProperty('Consultation', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId) {
      throw new BusinessException('Consultation ID is required');
    }
    if (!Number.isInteger(this._seq) || this._seq < 1) {
      throw new BusinessException('Encounter seq must be a positive integer');
    }
    if (!this._visitType) {
      throw new BusinessException('Visit type is required');
    }
  }
}
