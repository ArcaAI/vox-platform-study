import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { DnaSampleSource } from '../../../enums';

// TASK-1034 — one DNA writing-style memory sample. Text is Vault-Transit
// (hope-phi) ciphertext only; plaintext is never a field on this entity.
export interface IDnaWritingSampleEntity extends IBaseTenantEntity {
  doctorId?: string | null;
  source?: DnaSampleSource | null;
  textCiphertext?: Buffer | null;
  aiDraftCiphertext?: Buffer | null;
  keyVersion?: number | null;
  writtenAt?: Date | null;
  kind?: string | null;
  sourceRef?: string | null;
  contentHash?: string | null;
  ingestBatchId?: string | null;
  consultationId?: string | null;
  contextItemId?: string | null;
  consumedByReportId?: string | null;
  consumedAt?: Date | null;
}

export class DnaWritingSampleEntity extends BaseTenantEntity {
  private _doctorId?: IDnaWritingSampleEntity['doctorId'];
  private _source?: IDnaWritingSampleEntity['source'];
  private _textCiphertext?: IDnaWritingSampleEntity['textCiphertext'];
  private _aiDraftCiphertext?: IDnaWritingSampleEntity['aiDraftCiphertext'];
  private _keyVersion?: IDnaWritingSampleEntity['keyVersion'];
  private _writtenAt?: IDnaWritingSampleEntity['writtenAt'];
  private _kind?: IDnaWritingSampleEntity['kind'];
  private _sourceRef?: IDnaWritingSampleEntity['sourceRef'];
  private _contentHash?: IDnaWritingSampleEntity['contentHash'];
  private _ingestBatchId?: IDnaWritingSampleEntity['ingestBatchId'];
  private _consultationId?: IDnaWritingSampleEntity['consultationId'];
  private _contextItemId?: IDnaWritingSampleEntity['contextItemId'];
  private _consumedByReportId?: IDnaWritingSampleEntity['consumedByReportId'];
  private _consumedAt?: IDnaWritingSampleEntity['consumedAt'];

  constructor(init: IDnaWritingSampleEntity) {
    super(init);
    this._doctorId = init.doctorId;
    this._source = init.source;
    this._textCiphertext = init.textCiphertext;
    this._aiDraftCiphertext = init.aiDraftCiphertext;
    this._keyVersion = init.keyVersion;
    this._writtenAt = init.writtenAt;
    this._kind = init.kind;
    this._sourceRef = init.sourceRef;
    this._contentHash = init.contentHash;
    this._ingestBatchId = init.ingestBatchId;
    this._consultationId = init.consultationId;
    this._contextItemId = init.contextItemId;
    this._consumedByReportId = init.consumedByReportId;
    this._consumedAt = init.consumedAt;
  }

  get doctorId(): IDnaWritingSampleEntity['doctorId'] {
    return this._doctorId;
  }

  set doctorId(value: IDnaWritingSampleEntity['doctorId']) {
    this.setProperty('doctorId', value);
  }

  get source(): IDnaWritingSampleEntity['source'] {
    return this._source;
  }

  set source(value: IDnaWritingSampleEntity['source']) {
    this.setProperty('source', value);
  }

  @Secret()
  get textCiphertext(): IDnaWritingSampleEntity['textCiphertext'] {
    return this._textCiphertext;
  }

  set textCiphertext(value: IDnaWritingSampleEntity['textCiphertext']) {
    this.setProperty('textCiphertext', value);
  }

  @Secret()
  get aiDraftCiphertext(): IDnaWritingSampleEntity['aiDraftCiphertext'] {
    return this._aiDraftCiphertext;
  }

  set aiDraftCiphertext(value: IDnaWritingSampleEntity['aiDraftCiphertext']) {
    this.setProperty('aiDraftCiphertext', value);
  }

  get keyVersion(): IDnaWritingSampleEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IDnaWritingSampleEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get writtenAt(): IDnaWritingSampleEntity['writtenAt'] {
    return this._writtenAt;
  }

  set writtenAt(value: IDnaWritingSampleEntity['writtenAt']) {
    this.setProperty('writtenAt', value);
  }

  get kind(): IDnaWritingSampleEntity['kind'] {
    return this._kind;
  }

  set kind(value: IDnaWritingSampleEntity['kind']) {
    this.setProperty('kind', value);
  }

  get sourceRef(): IDnaWritingSampleEntity['sourceRef'] {
    return this._sourceRef;
  }

  set sourceRef(value: IDnaWritingSampleEntity['sourceRef']) {
    this.setProperty('sourceRef', value);
  }

  get contentHash(): IDnaWritingSampleEntity['contentHash'] {
    return this._contentHash;
  }

  set contentHash(value: IDnaWritingSampleEntity['contentHash']) {
    this.setProperty('contentHash', value);
  }

  get ingestBatchId(): IDnaWritingSampleEntity['ingestBatchId'] {
    return this._ingestBatchId;
  }

  set ingestBatchId(value: IDnaWritingSampleEntity['ingestBatchId']) {
    this.setProperty('ingestBatchId', value);
  }

  get consultationId(): IDnaWritingSampleEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IDnaWritingSampleEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get contextItemId(): IDnaWritingSampleEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: IDnaWritingSampleEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get consumedByReportId(): IDnaWritingSampleEntity['consumedByReportId'] {
    return this._consumedByReportId;
  }

  set consumedByReportId(value: IDnaWritingSampleEntity['consumedByReportId']) {
    this.setProperty('consumedByReportId', value);
  }

  get consumedAt(): IDnaWritingSampleEntity['consumedAt'] {
    return this._consumedAt;
  }

  set consumedAt(value: IDnaWritingSampleEntity['consumedAt']) {
    this.setProperty('consumedAt', value);
  }

  public markConsumed(reportId: string, at: Date = new Date()): void {
    this.setProperty('consumedByReportId', reportId);
    this.setProperty('consumedAt', at);
  }
}
