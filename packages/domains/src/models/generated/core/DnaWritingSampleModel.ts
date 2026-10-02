/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DnaWritingSample extends BaseTenantDataModel {
  public doctorId: string;
  public source: Enums.DnaSampleSource;
  public textCiphertext: Uint8Array;
  public aiDraftCiphertext: Uint8Array | null;
  public keyVersion: number | null;
  public writtenAt: Date;
  public kind: string | null;
  public sourceRef: string | null;
  public contentHash: string;
  public ingestBatchId: string | null;
  public consultationId: string | null;
  public contextItemId: string | null;
  public consumedByReportId: string | null;
  public consumedAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: DnaWritingSample & BaseTenantDataModel) {
    super(data);
    this.doctorId = data.doctorId;
    this.source = data.source;
    this.textCiphertext = data.textCiphertext;
    this.aiDraftCiphertext = data.aiDraftCiphertext;
    this.keyVersion = data.keyVersion;
    this.writtenAt = data.writtenAt;
    this.kind = data.kind;
    this.sourceRef = data.sourceRef;
    this.contentHash = data.contentHash;
    this.ingestBatchId = data.ingestBatchId;
    this.consultationId = data.consultationId;
    this.contextItemId = data.contextItemId;
    this.consumedByReportId = data.consumedByReportId;
    this.consumedAt = data.consumedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
