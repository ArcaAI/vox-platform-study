/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantCheckpointRestore extends BaseTenantDataModel {
  public checkpointId: string;
  public categories: Enums.TenantCheckpointCategory[];
  public reason: string;
  public status: Enums.TenantCheckpointRestoreStatus;
  public safetyCheckpointId: string | null;
  public counts: JsonValue | null;
  public warnings: JsonValue | null;
  public requestedBy: string;
  public heartbeatAt: Date | null;
  public lockAcquiredAt: Date | null;
  public lockReleasedAt: Date | null;
  public startedAt: Date | null;
  public finishedAt: Date | null;
  public failureReason: string | null;
  public failureDetail: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public checkpoint: Models.TenantCheckpoint | undefined;

  constructor(data: TenantCheckpointRestore & BaseTenantDataModel) {
    super(data);
    this.checkpointId = data.checkpointId;
    this.categories = data.categories;
    this.reason = data.reason;
    this.status = data.status;
    this.safetyCheckpointId = data.safetyCheckpointId;
    this.counts = data.counts;
    this.warnings = data.warnings;
    this.requestedBy = data.requestedBy;
    this.heartbeatAt = data.heartbeatAt;
    this.lockAcquiredAt = data.lockAcquiredAt;
    this.lockReleasedAt = data.lockReleasedAt;
    this.startedAt = data.startedAt;
    this.finishedAt = data.finishedAt;
    this.failureReason = data.failureReason;
    this.failureDetail = data.failureDetail;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.checkpoint = data.checkpoint;
  }
}
