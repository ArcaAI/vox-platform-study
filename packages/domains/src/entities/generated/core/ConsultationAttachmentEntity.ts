/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * One uploaded file attached to a consultation (or, with `purpose = FEEDBACK`,
 * to a feedback entry). Created as an upload INTENT and moved through
 * UPLOADED → PROCESSING → READY (or FAILED / EXPIRED). The object key carries
 * ids only; the original file name is PHI-prone and persists only as
 * Vault-Transit (hope-phi) ciphertext in `encryptedFileName` (`keyVersion`).
 */
export interface IConsultationAttachmentEntity extends IBaseTenantEntity {
  consultationId: string;
  encounterSeq?: number | null;
  purpose: Enums.ConsultationAttachmentPurpose;
  kind: Enums.ConsultationAttachmentKind;
  status: Enums.ConsultationAttachmentStatus;
  // PRESIGNED | GATEWAY
  uploadMode: string;
  declaredMime: string;
  declaredSizeBytes: number;
  // hex
  declaredSha256: string;
  bucketName: string;
  // ids only
  objectKey: string;
  encryptedFileName?: Buffer | null;
  keyVersion?: number | null;
  idempotencyKey?: string | null;
  uploadExpiresAt: Date;
  // reaper cutoff
  intentExpiresAt: Date;
  completedAt?: Date | null;
  failureCode?: string | null;
  mediaId?: string | null;
  contextItemId?: string | null;
  transcriptionJobId?: string | null;
}

export class ConsultationAttachmentEntity extends BaseTenantEntity {
  private _metaData?: IConsultationAttachmentEntity['metaData'];
  private _consultationId: IConsultationAttachmentEntity['consultationId'];
  private _encounterSeq?: IConsultationAttachmentEntity['encounterSeq'];
  private _purpose: IConsultationAttachmentEntity['purpose'];
  private _kind: IConsultationAttachmentEntity['kind'];
  private _status: IConsultationAttachmentEntity['status'];
  private _uploadMode: IConsultationAttachmentEntity['uploadMode'];
  private _declaredMime: IConsultationAttachmentEntity['declaredMime'];
  private _declaredSizeBytes: IConsultationAttachmentEntity['declaredSizeBytes'];
  private _declaredSha256: IConsultationAttachmentEntity['declaredSha256'];
  private _bucketName: IConsultationAttachmentEntity['bucketName'];
  private _objectKey: IConsultationAttachmentEntity['objectKey'];
  private _encryptedFileName?: IConsultationAttachmentEntity['encryptedFileName'];
  private _keyVersion?: IConsultationAttachmentEntity['keyVersion'];
  private _idempotencyKey?: IConsultationAttachmentEntity['idempotencyKey'];
  private _uploadExpiresAt: IConsultationAttachmentEntity['uploadExpiresAt'];
  private _intentExpiresAt: IConsultationAttachmentEntity['intentExpiresAt'];
  private _completedAt?: IConsultationAttachmentEntity['completedAt'];
  private _failureCode?: IConsultationAttachmentEntity['failureCode'];
  private _mediaId?: IConsultationAttachmentEntity['mediaId'];
  private _contextItemId?: IConsultationAttachmentEntity['contextItemId'];
  private _transcriptionJobId?: IConsultationAttachmentEntity['transcriptionJobId'];

  constructor(init: IConsultationAttachmentEntity) {
    super(init);
    this._metaData = init.metaData;
    this._consultationId = init.consultationId;
    this._encounterSeq = init.encounterSeq;
    this._purpose = init.purpose;
    this._kind = init.kind;
    this._status = init.status;
    this._uploadMode = init.uploadMode;
    this._declaredMime = init.declaredMime;
    this._declaredSizeBytes = init.declaredSizeBytes;
    this._declaredSha256 = init.declaredSha256;
    this._bucketName = init.bucketName;
    this._objectKey = init.objectKey;
    this._encryptedFileName = init.encryptedFileName;
    this._keyVersion = init.keyVersion;
    this._idempotencyKey = init.idempotencyKey;
    this._uploadExpiresAt = init.uploadExpiresAt;
    this._intentExpiresAt = init.intentExpiresAt;
    this._completedAt = init.completedAt;
    this._failureCode = init.failureCode;
    this._mediaId = init.mediaId;
    this._contextItemId = init.contextItemId;
    this._transcriptionJobId = init.transcriptionJobId;
  }

  get metaData(): IConsultationAttachmentEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IConsultationAttachmentEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  get consultationId(): IConsultationAttachmentEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: IConsultationAttachmentEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get encounterSeq(): IConsultationAttachmentEntity['encounterSeq'] {
    return this._encounterSeq;
  }

  set encounterSeq(value: IConsultationAttachmentEntity['encounterSeq']) {
    this.setProperty('encounterSeq', value);
  }

  get purpose(): IConsultationAttachmentEntity['purpose'] {
    return this._purpose;
  }

  set purpose(value: IConsultationAttachmentEntity['purpose']) {
    this.setProperty('purpose', value);
  }

  get kind(): IConsultationAttachmentEntity['kind'] {
    return this._kind;
  }

  set kind(value: IConsultationAttachmentEntity['kind']) {
    this.setProperty('kind', value);
  }

  get status(): IConsultationAttachmentEntity['status'] {
    return this._status;
  }

  set status(value: IConsultationAttachmentEntity['status']) {
    this.setProperty('status', value);
  }

  get uploadMode(): IConsultationAttachmentEntity['uploadMode'] {
    return this._uploadMode;
  }

  set uploadMode(value: IConsultationAttachmentEntity['uploadMode']) {
    this.setProperty('uploadMode', value);
  }

  get declaredMime(): IConsultationAttachmentEntity['declaredMime'] {
    return this._declaredMime;
  }

  set declaredMime(value: IConsultationAttachmentEntity['declaredMime']) {
    this.setProperty('declaredMime', value);
  }

  get declaredSizeBytes(): IConsultationAttachmentEntity['declaredSizeBytes'] {
    return this._declaredSizeBytes;
  }

  set declaredSizeBytes(value: IConsultationAttachmentEntity['declaredSizeBytes']) {
    this.setProperty('declaredSizeBytes', value);
  }

  get declaredSha256(): IConsultationAttachmentEntity['declaredSha256'] {
    return this._declaredSha256;
  }

  set declaredSha256(value: IConsultationAttachmentEntity['declaredSha256']) {
    this.setProperty('declaredSha256', value);
  }

  get bucketName(): IConsultationAttachmentEntity['bucketName'] {
    return this._bucketName;
  }

  set bucketName(value: IConsultationAttachmentEntity['bucketName']) {
    this.setProperty('bucketName', value);
  }

  get objectKey(): IConsultationAttachmentEntity['objectKey'] {
    return this._objectKey;
  }

  set objectKey(value: IConsultationAttachmentEntity['objectKey']) {
    this.setProperty('objectKey', value);
  }

  // Vault-Transit ciphertext of the original file name (PHI-prone).
  @Secret()
  get encryptedFileName(): IConsultationAttachmentEntity['encryptedFileName'] {
    return this._encryptedFileName;
  }

  set encryptedFileName(value: IConsultationAttachmentEntity['encryptedFileName']) {
    this.setProperty('encryptedFileName', value);
  }

  get keyVersion(): IConsultationAttachmentEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IConsultationAttachmentEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get idempotencyKey(): IConsultationAttachmentEntity['idempotencyKey'] {
    return this._idempotencyKey;
  }

  set idempotencyKey(value: IConsultationAttachmentEntity['idempotencyKey']) {
    this.setProperty('idempotencyKey', value);
  }

  get uploadExpiresAt(): IConsultationAttachmentEntity['uploadExpiresAt'] {
    return this._uploadExpiresAt;
  }

  set uploadExpiresAt(value: IConsultationAttachmentEntity['uploadExpiresAt']) {
    this.setProperty('uploadExpiresAt', value);
  }

  get intentExpiresAt(): IConsultationAttachmentEntity['intentExpiresAt'] {
    return this._intentExpiresAt;
  }

  set intentExpiresAt(value: IConsultationAttachmentEntity['intentExpiresAt']) {
    this.setProperty('intentExpiresAt', value);
  }

  get completedAt(): IConsultationAttachmentEntity['completedAt'] {
    return this._completedAt;
  }

  set completedAt(value: IConsultationAttachmentEntity['completedAt']) {
    this.setProperty('completedAt', value);
  }

  get failureCode(): IConsultationAttachmentEntity['failureCode'] {
    return this._failureCode;
  }

  set failureCode(value: IConsultationAttachmentEntity['failureCode']) {
    this.setProperty('failureCode', value);
  }

  get mediaId(): IConsultationAttachmentEntity['mediaId'] {
    return this._mediaId;
  }

  set mediaId(value: IConsultationAttachmentEntity['mediaId']) {
    this.setProperty('mediaId', value);
  }

  get contextItemId(): IConsultationAttachmentEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: IConsultationAttachmentEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get transcriptionJobId(): IConsultationAttachmentEntity['transcriptionJobId'] {
    return this._transcriptionJobId;
  }

  set transcriptionJobId(value: IConsultationAttachmentEntity['transcriptionJobId']) {
    this.setProperty('transcriptionJobId', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._consultationId) {
      throw new BusinessException('Consultation ID is required');
    }
    if (!this._objectKey) {
      throw new BusinessException('Object key is required');
    }
    if (!Number.isInteger(this._declaredSizeBytes) || this._declaredSizeBytes < 0) {
      throw new BusinessException('Declared size must be a non-negative integer');
    }
  }
}
