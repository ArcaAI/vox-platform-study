/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Immutable approval snapshot, written once when a clinician approves a
 * consultation. `snapshot` lists the approved record by reference only —
 * `{items:[{contextItemId, type, versionNumber, encounterSeq}]}`, never
 * content — and `snapshotHash` pins it. A database trigger refuses UPDATE
 * and DELETE; a re-approval after a reopen is a new row.
 */
export interface IConsultationApprovalEntity extends IBaseTenantEntity {
  consultationId: string;
  approvedBy: string;
  approvedAt: Date;
  consultationVersion: number;
  encounterCount: number;
  snapshot: JsonValue;
  snapshotHash: string;
  attestationHash?: string | null;
  Consultation?: Entities.ConsultationEntity | null;
}

export class ConsultationApprovalEntity extends BaseTenantEntity {
  private _metaData?: IConsultationApprovalEntity['metaData'];
  private _consultationId: IConsultationApprovalEntity['consultationId'];
  private _approvedBy: IConsultationApprovalEntity['approvedBy'];
  private _approvedAt: IConsultationApprovalEntity['approvedAt'];
  private _consultationVersion: IConsultationApprovalEntity['consultationVersion'];
  private _encounterCount: IConsultationApprovalEntity['encounterCount'];
  private _snapshot: IConsultationApprovalEntity['snapshot'];
  private _snapshotHash: IConsultationApprovalEntity['snapshotHash'];
  private _attestationHash?: IConsultationApprovalEntity['attestationHash'];
  private _Consultation?: IConsultationApprovalEntity['Consultation'];

  constructor(init: IConsultationApprovalEntity) {
    super(init);
    this._metaData = init.metaData;
    this._consultationId = init.consultationId;
    this._approvedBy = init.approvedBy;
    this._approvedAt = init.approvedAt;
    this._consultationVersion = init.consultationVersion;
    this._encounterCount = init.encounterCount;
    this._snapshot = init.snapshot;
    this._snapshotHash = init.snapshotHash;
    this._attestationHash = init.attestationHash;
    this._Consultation = init.Consultation;
  }

  get metaData(): IConsultationApprovalEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IConsultationApprovalEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  get consultationId(): IConsultationApprovalEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IConsultationApprovalEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get approvedBy(): IConsultationApprovalEntity['approvedBy'] {
    return this._approvedBy;
  }

  set approvedBy(value: IConsultationApprovalEntity['approvedBy']) {
    this.setProperty('approvedBy', value);
  }

  get approvedAt(): IConsultationApprovalEntity['approvedAt'] {
    return this._approvedAt;
  }

  set approvedAt(value: IConsultationApprovalEntity['approvedAt']) {
    this.setProperty('approvedAt', value);
  }

  get consultationVersion(): IConsultationApprovalEntity['consultationVersion'] {
    return this._consultationVersion;
  }

  set consultationVersion(value: IConsultationApprovalEntity['consultationVersion']) {
    this.setProperty('consultationVersion', value);
  }

  get encounterCount(): IConsultationApprovalEntity['encounterCount'] {
    return this._encounterCount;
  }

  set encounterCount(value: IConsultationApprovalEntity['encounterCount']) {
    this.setProperty('encounterCount', value);
  }

  get snapshot(): IConsultationApprovalEntity['snapshot'] {
    return this._snapshot;
  }

  set snapshot(value: IConsultationApprovalEntity['snapshot']) {
    this.setProperty('snapshot', value);
  }

  get snapshotHash(): IConsultationApprovalEntity['snapshotHash'] {
    return this._snapshotHash;
  }

  set snapshotHash(value: IConsultationApprovalEntity['snapshotHash']) {
    this.setProperty('snapshotHash', value);
  }

  get attestationHash(): IConsultationApprovalEntity['attestationHash'] {
    return this._attestationHash;
  }

  set attestationHash(value: IConsultationApprovalEntity['attestationHash']) {
    this.setProperty('attestationHash', value);
  }

  get Consultation(): IConsultationApprovalEntity['Consultation'] {
    return this._Consultation;
  }

  set Consultation(value: IConsultationApprovalEntity['Consultation']) {
    this.setProperty('Consultation', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId) {
      throw new BusinessException('Consultation ID is required');
    }
    if (!this._approvedBy) {
      throw new BusinessException('Approver is required');
    }
    if (!this._snapshotHash) {
      throw new BusinessException('Snapshot hash is required');
    }
  }
}
