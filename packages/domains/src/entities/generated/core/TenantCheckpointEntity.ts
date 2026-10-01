/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import { TenantCheckpointKind, TenantCheckpointOrigin, TenantCheckpointStatus } from '../../../enums';

export interface ITenantCheckpointEntity extends IBaseTenantEntity {
  label: string;
  kind: TenantCheckpointKind;
  origin: TenantCheckpointOrigin;
  status: TenantCheckpointStatus;
  includesMedia: boolean;
  passphraseProtected: boolean;
  keyEnvelope?: JsonValue | null;
  objectKey?: string | null;
  uploadId?: string | null;
  sizeBytes?: number | null;
  manifestDigest?: string | null;
  manifestSummary?: JsonValue | null;
  schemaFingerprint?: string | null;
  sourceDeploymentId?: string | null;
  formatVersion: number;
  progress?: JsonValue | null;
  heartbeatAt?: Date | null;
  cancelRequestedAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  expiresAt?: Date | null;
  failureReason?: string | null;
  failureDetail?: string | null;
}

export class TenantCheckpointEntity extends BaseTenantEntity {
  private _label: ITenantCheckpointEntity['label'];
  private _kind: ITenantCheckpointEntity['kind'];
  private _origin: ITenantCheckpointEntity['origin'];
  private _status: ITenantCheckpointEntity['status'];
  private _includesMedia: ITenantCheckpointEntity['includesMedia'];
  private _passphraseProtected: ITenantCheckpointEntity['passphraseProtected'];
  private _keyEnvelope?: ITenantCheckpointEntity['keyEnvelope'];
  private _objectKey?: ITenantCheckpointEntity['objectKey'];
  private _uploadId?: ITenantCheckpointEntity['uploadId'];
  private _sizeBytes?: ITenantCheckpointEntity['sizeBytes'];
  private _manifestDigest?: ITenantCheckpointEntity['manifestDigest'];
  private _manifestSummary?: ITenantCheckpointEntity['manifestSummary'];
  private _schemaFingerprint?: ITenantCheckpointEntity['schemaFingerprint'];
  private _sourceDeploymentId?: ITenantCheckpointEntity['sourceDeploymentId'];
  private _formatVersion: ITenantCheckpointEntity['formatVersion'];
  private _progress?: ITenantCheckpointEntity['progress'];
  private _heartbeatAt?: ITenantCheckpointEntity['heartbeatAt'];
  private _cancelRequestedAt?: ITenantCheckpointEntity['cancelRequestedAt'];
  private _startedAt?: ITenantCheckpointEntity['startedAt'];
  private _finishedAt?: ITenantCheckpointEntity['finishedAt'];
  private _expiresAt?: ITenantCheckpointEntity['expiresAt'];
  private _failureReason?: ITenantCheckpointEntity['failureReason'];
  private _failureDetail?: ITenantCheckpointEntity['failureDetail'];
  // `IBaseEntity.metaData` is not wired on `BaseEntity`; implemented locally
  // (same as `AiModelEntity`) so the `_metadata` JSON survives the round-trip.
  private _metaData?: ITenantCheckpointEntity['metaData'];

  constructor(init: ITenantCheckpointEntity) {
    super(init);
    this._label = init.label;
    this._kind = init.kind;
    this._origin = init.origin;
    this._status = init.status;
    this._includesMedia = init.includesMedia;
    this._passphraseProtected = init.passphraseProtected;
    this._keyEnvelope = init.keyEnvelope;
    this._objectKey = init.objectKey;
    this._uploadId = init.uploadId;
    this._sizeBytes = init.sizeBytes;
    this._manifestDigest = init.manifestDigest;
    this._manifestSummary = init.manifestSummary;
    this._schemaFingerprint = init.schemaFingerprint;
    this._sourceDeploymentId = init.sourceDeploymentId;
    this._formatVersion = init.formatVersion;
    this._progress = init.progress;
    this._heartbeatAt = init.heartbeatAt;
    this._cancelRequestedAt = init.cancelRequestedAt;
    this._startedAt = init.startedAt;
    this._finishedAt = init.finishedAt;
    this._expiresAt = init.expiresAt;
    this._failureReason = init.failureReason;
    this._failureDetail = init.failureDetail;
    this._metaData = init.metaData;
  }

  get metaData(): ITenantCheckpointEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: ITenantCheckpointEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  get label(): ITenantCheckpointEntity['label'] {
    return this._label;
  }

  set label(value: ITenantCheckpointEntity['label']) {
    this.setProperty('label', value);
  }

  get kind(): ITenantCheckpointEntity['kind'] {
    return this._kind;
  }

  set kind(value: ITenantCheckpointEntity['kind']) {
    this.setProperty('kind', value);
  }

  get origin(): ITenantCheckpointEntity['origin'] {
    return this._origin;
  }

  set origin(value: ITenantCheckpointEntity['origin']) {
    this.setProperty('origin', value);
  }

  get status(): ITenantCheckpointEntity['status'] {
    return this._status;
  }

  set status(value: ITenantCheckpointEntity['status']) {
    this.setProperty('status', value);
  }

  get includesMedia(): ITenantCheckpointEntity['includesMedia'] {
    return this._includesMedia;
  }

  set includesMedia(value: ITenantCheckpointEntity['includesMedia']) {
    this.setProperty('includesMedia', value);
  }

  get passphraseProtected(): ITenantCheckpointEntity['passphraseProtected'] {
    return this._passphraseProtected;
  }

  set passphraseProtected(value: ITenantCheckpointEntity['passphraseProtected']) {
    this.setProperty('passphraseProtected', value);
  }

  get keyEnvelope(): ITenantCheckpointEntity['keyEnvelope'] {
    return this._keyEnvelope;
  }

  set keyEnvelope(value: ITenantCheckpointEntity['keyEnvelope']) {
    this.setProperty('keyEnvelope', value);
  }

  get objectKey(): ITenantCheckpointEntity['objectKey'] {
    return this._objectKey;
  }

  set objectKey(value: ITenantCheckpointEntity['objectKey']) {
    this.setProperty('objectKey', value);
  }

  get uploadId(): ITenantCheckpointEntity['uploadId'] {
    return this._uploadId;
  }

  set uploadId(value: ITenantCheckpointEntity['uploadId']) {
    this.setProperty('uploadId', value);
  }

  get sizeBytes(): ITenantCheckpointEntity['sizeBytes'] {
    return this._sizeBytes;
  }

  set sizeBytes(value: ITenantCheckpointEntity['sizeBytes']) {
    this.setProperty('sizeBytes', value);
  }

  get manifestDigest(): ITenantCheckpointEntity['manifestDigest'] {
    return this._manifestDigest;
  }

  set manifestDigest(value: ITenantCheckpointEntity['manifestDigest']) {
    this.setProperty('manifestDigest', value);
  }

  get manifestSummary(): ITenantCheckpointEntity['manifestSummary'] {
    return this._manifestSummary;
  }

  set manifestSummary(value: ITenantCheckpointEntity['manifestSummary']) {
    this.setProperty('manifestSummary', value);
  }

  get schemaFingerprint(): ITenantCheckpointEntity['schemaFingerprint'] {
    return this._schemaFingerprint;
  }

  set schemaFingerprint(value: ITenantCheckpointEntity['schemaFingerprint']) {
    this.setProperty('schemaFingerprint', value);
  }

  get sourceDeploymentId(): ITenantCheckpointEntity['sourceDeploymentId'] {
    return this._sourceDeploymentId;
  }

  set sourceDeploymentId(value: ITenantCheckpointEntity['sourceDeploymentId']) {
    this.setProperty('sourceDeploymentId', value);
  }

  get formatVersion(): ITenantCheckpointEntity['formatVersion'] {
    return this._formatVersion;
  }

  set formatVersion(value: ITenantCheckpointEntity['formatVersion']) {
    this.setProperty('formatVersion', value);
  }

  get progress(): ITenantCheckpointEntity['progress'] {
    return this._progress;
  }

  set progress(value: ITenantCheckpointEntity['progress']) {
    this.setProperty('progress', value);
  }

  get heartbeatAt(): ITenantCheckpointEntity['heartbeatAt'] {
    return this._heartbeatAt;
  }

  set heartbeatAt(value: ITenantCheckpointEntity['heartbeatAt']) {
    this.setProperty('heartbeatAt', value);
  }

  get cancelRequestedAt(): ITenantCheckpointEntity['cancelRequestedAt'] {
    return this._cancelRequestedAt;
  }

  set cancelRequestedAt(value: ITenantCheckpointEntity['cancelRequestedAt']) {
    this.setProperty('cancelRequestedAt', value);
  }

  get startedAt(): ITenantCheckpointEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: ITenantCheckpointEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get finishedAt(): ITenantCheckpointEntity['finishedAt'] {
    return this._finishedAt;
  }

  set finishedAt(value: ITenantCheckpointEntity['finishedAt']) {
    this.setProperty('finishedAt', value);
  }

  get expiresAt(): ITenantCheckpointEntity['expiresAt'] {
    return this._expiresAt;
  }

  set expiresAt(value: ITenantCheckpointEntity['expiresAt']) {
    this.setProperty('expiresAt', value);
  }

  get failureReason(): ITenantCheckpointEntity['failureReason'] {
    return this._failureReason;
  }

  set failureReason(value: ITenantCheckpointEntity['failureReason']) {
    this.setProperty('failureReason', value);
  }

  get failureDetail(): ITenantCheckpointEntity['failureDetail'] {
    return this._failureDetail;
  }

  set failureDetail(value: ITenantCheckpointEntity['failureDetail']) {
    this.setProperty('failureDetail', value);
  }

  public override validate(): void {
    super.validate();
    if (!this.label || this.label.trim().length === 0) {
      throw new BusinessException('Checkpoint label is required');
    }
    if (this.sizeBytes != null && (!Number.isInteger(this.sizeBytes) || this.sizeBytes < 0)) {
      throw new BusinessException('Checkpoint size must be a non-negative integer');
    }
  }
}
