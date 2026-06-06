/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

export interface IContextItemVersionEntity extends IBaseTenantEntity {
  contextItemId: string;
  versionNumber: number;
  content?: string | null;
  contentDiff?: string | null;
  changeReason?: string | null;
  changeSummary?: string | null;
  changedBy?: string | null;
  changeSource?: string | null;
  fieldChanges?: JsonValue | null;
  // TASK-330 Phase 1 — clinician attestation fields
  attestedAt?: Date | null;
  attestedBy?: string | null;
  attestationHash?: string | null;
  modelName?: string | null;
  modelVersion?: string | null;
  sensorScores?: JsonValue | null;
  ContextItem?: Entities.ContextItemEntity | null;
}

export class ContextItemVersionEntity extends BaseTenantEntity {
  private _contextItemId: IContextItemVersionEntity['contextItemId'];
  private _versionNumber: IContextItemVersionEntity['versionNumber'];
  private _content?: IContextItemVersionEntity['content'];
  private _contentDiff?: IContextItemVersionEntity['contentDiff'];
  private _changeReason?: IContextItemVersionEntity['changeReason'];
  private _changeSummary?: IContextItemVersionEntity['changeSummary'];
  private _changedBy?: IContextItemVersionEntity['changedBy'];
  private _changeSource?: IContextItemVersionEntity['changeSource'];
  private _fieldChanges?: IContextItemVersionEntity['fieldChanges'];
  private _attestedAt?: IContextItemVersionEntity['attestedAt'];
  private _attestedBy?: IContextItemVersionEntity['attestedBy'];
  private _attestationHash?: IContextItemVersionEntity['attestationHash'];
  private _modelName?: IContextItemVersionEntity['modelName'];
  private _modelVersion?: IContextItemVersionEntity['modelVersion'];
  private _sensorScores?: IContextItemVersionEntity['sensorScores'];
  private _ContextItem?: IContextItemVersionEntity['ContextItem'];

  constructor(init: IContextItemVersionEntity) {
    super(init);
    this._contextItemId = init.contextItemId;
    this._versionNumber = init.versionNumber;
    this._content = init.content;
    this._contentDiff = init.contentDiff;
    this._changeReason = init.changeReason;
    this._changeSummary = init.changeSummary;
    this._changedBy = init.changedBy;
    this._changeSource = init.changeSource;
    this._fieldChanges = init.fieldChanges;
    this._attestedAt = init.attestedAt;
    this._attestedBy = init.attestedBy;
    this._attestationHash = init.attestationHash;
    this._modelName = init.modelName;
    this._modelVersion = init.modelVersion;
    this._sensorScores = init.sensorScores;
    this._ContextItem = init.ContextItem;
  }

  get contextItemId(): IContextItemVersionEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: IContextItemVersionEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get versionNumber(): IContextItemVersionEntity['versionNumber'] {
    return this._versionNumber;
  }

  set versionNumber(value: IContextItemVersionEntity['versionNumber']) {
    this.setProperty('versionNumber', value);
  }

  get content(): IContextItemVersionEntity['content'] {
    return this._content;
  }

  set content(value: IContextItemVersionEntity['content']) {
    this.setProperty('content', value);
  }

  get contentDiff(): IContextItemVersionEntity['contentDiff'] {
    return this._contentDiff;
  }

  set contentDiff(value: IContextItemVersionEntity['contentDiff']) {
    this.setProperty('contentDiff', value);
  }

  get changeReason(): IContextItemVersionEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: IContextItemVersionEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  get changeSummary(): IContextItemVersionEntity['changeSummary'] {
    return this._changeSummary;
  }

  set changeSummary(value: IContextItemVersionEntity['changeSummary']) {
    this.setProperty('changeSummary', value);
  }

  get changedBy(): IContextItemVersionEntity['changedBy'] {
    return this._changedBy;
  }

  set changedBy(value: IContextItemVersionEntity['changedBy']) {
    this.setProperty('changedBy', value);
  }

  get changeSource(): IContextItemVersionEntity['changeSource'] {
    return this._changeSource;
  }

  set changeSource(value: IContextItemVersionEntity['changeSource']) {
    this.setProperty('changeSource', value);
  }

  get fieldChanges(): IContextItemVersionEntity['fieldChanges'] {
    return this._fieldChanges;
  }

  set fieldChanges(value: IContextItemVersionEntity['fieldChanges']) {
    this.setProperty('fieldChanges', value);
  }

  get attestedAt(): IContextItemVersionEntity['attestedAt'] {
    return this._attestedAt;
  }

  set attestedAt(value: IContextItemVersionEntity['attestedAt']) {
    this.setProperty('attestedAt', value);
  }

  get attestedBy(): IContextItemVersionEntity['attestedBy'] {
    return this._attestedBy;
  }

  set attestedBy(value: IContextItemVersionEntity['attestedBy']) {
    this.setProperty('attestedBy', value);
  }

  get attestationHash(): IContextItemVersionEntity['attestationHash'] {
    return this._attestationHash;
  }

  set attestationHash(value: IContextItemVersionEntity['attestationHash']) {
    this.setProperty('attestationHash', value);
  }

  get modelName(): IContextItemVersionEntity['modelName'] {
    return this._modelName;
  }

  set modelName(value: IContextItemVersionEntity['modelName']) {
    this.setProperty('modelName', value);
  }

  get modelVersion(): IContextItemVersionEntity['modelVersion'] {
    return this._modelVersion;
  }

  set modelVersion(value: IContextItemVersionEntity['modelVersion']) {
    this.setProperty('modelVersion', value);
  }

  get sensorScores(): IContextItemVersionEntity['sensorScores'] {
    return this._sensorScores;
  }

  set sensorScores(value: IContextItemVersionEntity['sensorScores']) {
    this.setProperty('sensorScores', value);
  }

  get ContextItem(): IContextItemVersionEntity['ContextItem'] {
    return this._ContextItem;
  }

  set ContextItem(value: IContextItemVersionEntity['ContextItem']) {
    this.setProperty('ContextItem', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if this is the first version
   */
  get isFirstVersion(): boolean {
    return this._versionNumber === 1;
  }

  /**
   * Check if this version has a diff recorded
   */
  get hasDiff(): boolean {
    return !!this._contentDiff;
  }

  /**
   * Check if this version has field-level changes recorded
   */
  get hasFieldChanges(): boolean {
    return !!this._fieldChanges;
  }

  /**
   * TASK-330 Phase 1 — true when this version carries a clinician attestation
   * (i.e. it is an immutable, signed note produced by the confirm-before-commit
   * gate). Anchored by the SHA-256 `attestationHash` linking to the WORM audit.
   */
  get isAttested(): boolean {
    return !!this._attestationHash;
  }

  public override validate(): void {
    super.validate();
    if (!this._contextItemId) {
      throw new BusinessException('Context item ID is required');
    }
    if (this._versionNumber === undefined || this._versionNumber < 1) {
      throw new BusinessException('Version number must be >= 1');
    }
  }
}
