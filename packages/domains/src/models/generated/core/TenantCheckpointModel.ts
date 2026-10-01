/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantCheckpoint extends BaseTenantDataModel {
  public label: string;
  public kind: Enums.TenantCheckpointKind;
  public origin: Enums.TenantCheckpointOrigin;
  public status: Enums.TenantCheckpointStatus;
  public includesMedia: boolean;
  public passphraseProtected: boolean;
  public keyEnvelope: JsonValue | null;
  public objectKey: string | null;
  public uploadId: string | null;
  public sizeBytes: bigint | null;
  public manifestDigest: string | null;
  public manifestSummary: JsonValue | null;
  public schemaFingerprint: string | null;
  public sourceDeploymentId: string | null;
  public formatVersion: number;
  public progress: JsonValue | null;
  public heartbeatAt: Date | null;
  public cancelRequestedAt: Date | null;
  public startedAt: Date | null;
  public finishedAt: Date | null;
  public expiresAt: Date | null;
  public failureReason: string | null;
  public failureDetail: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public restores: Models.TenantCheckpointRestore[] | undefined;

  constructor(data: TenantCheckpoint & BaseTenantDataModel) {
    super(data);
    this.label = data.label;
    this.kind = data.kind;
    this.origin = data.origin;
    this.status = data.status;
    this.includesMedia = data.includesMedia;
    this.passphraseProtected = data.passphraseProtected;
    this.keyEnvelope = data.keyEnvelope;
    this.objectKey = data.objectKey;
    this.uploadId = data.uploadId;
    this.sizeBytes = data.sizeBytes;
    this.manifestDigest = data.manifestDigest;
    this.manifestSummary = data.manifestSummary;
    this.schemaFingerprint = data.schemaFingerprint;
    this.sourceDeploymentId = data.sourceDeploymentId;
    this.formatVersion = data.formatVersion;
    this.progress = data.progress;
    this.heartbeatAt = data.heartbeatAt;
    this.cancelRequestedAt = data.cancelRequestedAt;
    this.startedAt = data.startedAt;
    this.finishedAt = data.finishedAt;
    this.expiresAt = data.expiresAt;
    this.failureReason = data.failureReason;
    this.failureDetail = data.failureDetail;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.restores = data.restores;
  }
}
