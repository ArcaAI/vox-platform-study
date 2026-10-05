/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsultationApproval extends BaseTenantDataModel {
  public consultationId: string;
  public approvedBy: string;
  public approvedAt: Date;
  public consultationVersion: number;
  public encounterCount: number;
  public snapshot: JsonValue;
  public snapshotHash: string;
  public attestationHash: string | null;
  @VirtualDbProperty()
  public Consultation: Models.Consultation | undefined;

  constructor(data: ConsultationApproval & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.approvedBy = data.approvedBy;
    this.approvedAt = data.approvedAt;
    this.consultationVersion = data.consultationVersion;
    this.encounterCount = data.encounterCount;
    this.snapshot = data.snapshot;
    this.snapshotHash = data.snapshotHash;
    this.attestationHash = data.attestationHash;
    this.Consultation = data.Consultation;
  }
}
