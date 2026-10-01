/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import { TenantCheckpointCategory, TenantCheckpointRestoreStatus } from '../../../enums';

export interface ITenantCheckpointRestoreEntity extends IBaseTenantEntity {
  checkpointId: string;
  categories: TenantCheckpointCategory[];
  reason: string;
  status: TenantCheckpointRestoreStatus;
  safetyCheckpointId?: string | null;
  counts?: JsonValue | null;
  warnings?: JsonValue | null;
  requestedBy: string;
  heartbeatAt?: Date | null;
  lockAcquiredAt?: Date | null;
  lockReleasedAt?: Date | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  failureReason?: string | null;
  failureDetail?: string | null;
  metaData?: Record<string, any>;
}

export class TenantCheckpointRestoreEntity extends BaseTenantEntity {
  private _checkpointId: ITenantCheckpointRestoreEntity['checkpointId'];
  private _categories: ITenantCheckpointRestoreEntity['categories'];
  private _reason: ITenantCheckpointRestoreEntity['reason'];
  private _status: ITenantCheckpointRestoreEntity['status'];
  private _safetyCheckpointId?: ITenantCheckpointRestoreEntity['safetyCheckpointId'];
  private _counts?: ITenantCheckpointRestoreEntity['counts'];
  private _warnings?: ITenantCheckpointRestoreEntity['warnings'];
  private _requestedBy: ITenantCheckpointRestoreEntity['requestedBy'];
  private _heartbeatAt?: ITenantCheckpointRestoreEntity['heartbeatAt'];
  private _lockAcquiredAt?: ITenantCheckpointRestoreEntity['lockAcquiredAt'];
  private _lockReleasedAt?: ITenantCheckpointRestoreEntity['lockReleasedAt'];
  private _startedAt?: ITenantCheckpointRestoreEntity['startedAt'];
  private _finishedAt?: ITenantCheckpointRestoreEntity['finishedAt'];
  private _failureReason?: ITenantCheckpointRestoreEntity['failureReason'];
  private _failureDetail?: ITenantCheckpointRestoreEntity['failureDetail'];
  private _metaData?: ITenantCheckpointRestoreEntity['metaData'];

  constructor(init: ITenantCheckpointRestoreEntity) {
    super(init);
    this._checkpointId = init.checkpointId;
    this._categories = init.categories;
    this._reason = init.reason;
    this._status = init.status;
    this._safetyCheckpointId = init.safetyCheckpointId;
    this._counts = init.counts;
    this._warnings = init.warnings;
    this._requestedBy = init.requestedBy;
    this._heartbeatAt = init.heartbeatAt;
    this._lockAcquiredAt = init.lockAcquiredAt;
    this._lockReleasedAt = init.lockReleasedAt;
    this._startedAt = init.startedAt;
    this._finishedAt = init.finishedAt;
    this._failureReason = init.failureReason;
    this._failureDetail = init.failureDetail;
    this._metaData = init.metaData;
  }

  get checkpointId(): ITenantCheckpointRestoreEntity['checkpointId'] {
    return this._checkpointId;
  }

  set checkpointId(value: ITenantCheckpointRestoreEntity['checkpointId']) {
    this.setProperty('checkpointId', value);
  }

  get categories(): ITenantCheckpointRestoreEntity['categories'] {
    return this._categories;
  }

  set categories(value: ITenantCheckpointRestoreEntity['categories']) {
    this.setProperty('categories', value);
  }

  get reason(): ITenantCheckpointRestoreEntity['reason'] {
    return this._reason;
  }

  set reason(value: ITenantCheckpointRestoreEntity['reason']) {
    this.setProperty('reason', value);
  }

  get status(): ITenantCheckpointRestoreEntity['status'] {
    return this._status;
  }

  set status(value: ITenantCheckpointRestoreEntity['status']) {
    this.setProperty('status', value);
  }

  get safetyCheckpointId(): ITenantCheckpointRestoreEntity['safetyCheckpointId'] {
    return this._safetyCheckpointId;
  }

  set safetyCheckpointId(value: ITenantCheckpointRestoreEntity['safetyCheckpointId']) {
    this.setProperty('safetyCheckpointId', value);
  }

  get counts(): ITenantCheckpointRestoreEntity['counts'] {
    return this._counts;
  }

  set counts(value: ITenantCheckpointRestoreEntity['counts']) {
    this.setProperty('counts', value);
  }

  get warnings(): ITenantCheckpointRestoreEntity['warnings'] {
    return this._warnings;
  }

  set warnings(value: ITenantCheckpointRestoreEntity['warnings']) {
    this.setProperty('warnings', value);
  }

  get requestedBy(): ITenantCheckpointRestoreEntity['requestedBy'] {
    return this._requestedBy;
  }

  set requestedBy(value: ITenantCheckpointRestoreEntity['requestedBy']) {
    this.setProperty('requestedBy', value);
  }

  get heartbeatAt(): ITenantCheckpointRestoreEntity['heartbeatAt'] {
    return this._heartbeatAt;
  }

  set heartbeatAt(value: ITenantCheckpointRestoreEntity['heartbeatAt']) {
    this.setProperty('heartbeatAt', value);
  }

  get lockAcquiredAt(): ITenantCheckpointRestoreEntity['lockAcquiredAt'] {
    return this._lockAcquiredAt;
  }

  set lockAcquiredAt(value: ITenantCheckpointRestoreEntity['lockAcquiredAt']) {
    this.setProperty('lockAcquiredAt', value);
  }

  get lockReleasedAt(): ITenantCheckpointRestoreEntity['lockReleasedAt'] {
    return this._lockReleasedAt;
  }

  set lockReleasedAt(value: ITenantCheckpointRestoreEntity['lockReleasedAt']) {
    this.setProperty('lockReleasedAt', value);
  }

  get startedAt(): ITenantCheckpointRestoreEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: ITenantCheckpointRestoreEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get finishedAt(): ITenantCheckpointRestoreEntity['finishedAt'] {
    return this._finishedAt;
  }

  set finishedAt(value: ITenantCheckpointRestoreEntity['finishedAt']) {
    this.setProperty('finishedAt', value);
  }

  get failureReason(): ITenantCheckpointRestoreEntity['failureReason'] {
    return this._failureReason;
  }

  set failureReason(value: ITenantCheckpointRestoreEntity['failureReason']) {
    this.setProperty('failureReason', value);
  }

  get failureDetail(): ITenantCheckpointRestoreEntity['failureDetail'] {
    return this._failureDetail;
  }

  set failureDetail(value: ITenantCheckpointRestoreEntity['failureDetail']) {
    this.setProperty('failureDetail', value);
  }

  get metaData(): ITenantCheckpointRestoreEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: ITenantCheckpointRestoreEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  public override validate(): void {
    super.validate();
    if (!this.checkpointId) {
      throw new BusinessException('Checkpoint id is required');
    }
    if (!this.reason || this.reason.trim().length === 0) {
      throw new BusinessException('Restore reason is required');
    }
  }
}
