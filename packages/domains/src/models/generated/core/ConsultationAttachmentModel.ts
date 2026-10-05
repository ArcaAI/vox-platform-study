/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsultationAttachment extends BaseTenantDataModel {
  public consultationId: string;
  public encounterSeq: number | null;
  public purpose: Enums.ConsultationAttachmentPurpose;
  public kind: Enums.ConsultationAttachmentKind;
  public status: Enums.ConsultationAttachmentStatus;
  public uploadMode: string;
  public declaredMime: string;
  public declaredSizeBytes: number;
  public declaredSha256: string;
  public bucketName: string;
  public objectKey: string;
  public encryptedFileName: Uint8Array | null;
  public keyVersion: number | null;
  public idempotencyKey: string | null;
  public uploadExpiresAt: Date;
  public intentExpiresAt: Date;
  public completedAt: Date | null;
  public failureCode: string | null;
  public mediaId: string | null;
  public contextItemId: string | null;
  public transcriptionJobId: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: ConsultationAttachment & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.encounterSeq = data.encounterSeq;
    this.purpose = data.purpose;
    this.kind = data.kind;
    this.status = data.status;
    this.uploadMode = data.uploadMode;
    this.declaredMime = data.declaredMime;
    this.declaredSizeBytes = data.declaredSizeBytes;
    this.declaredSha256 = data.declaredSha256;
    this.bucketName = data.bucketName;
    this.objectKey = data.objectKey;
    this.encryptedFileName = data.encryptedFileName;
    this.keyVersion = data.keyVersion;
    this.idempotencyKey = data.idempotencyKey;
    this.uploadExpiresAt = data.uploadExpiresAt;
    this.intentExpiresAt = data.intentExpiresAt;
    this.completedAt = data.completedAt;
    this.failureCode = data.failureCode;
    this.mediaId = data.mediaId;
    this.contextItemId = data.contextItemId;
    this.transcriptionJobId = data.transcriptionJobId;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
