/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsultationEncounter extends BaseTenantDataModel {
  public consultationId: string;
  public seq: number;
  public visitType: string;
  public externalRef: string | null;
  public startedAt: Date;
  public endedAt: Date | null;
  public recordingStartMs: number | null;
  public recordingEndMs: number | null;
  @VirtualDbProperty()
  public Consultation: Models.Consultation | undefined;

  constructor(data: ConsultationEncounter & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.seq = data.seq;
    this.visitType = data.visitType;
    this.externalRef = data.externalRef;
    this.startedAt = data.startedAt;
    this.endedAt = data.endedAt;
    this.recordingStartMs = data.recordingStartMs;
    this.recordingEndMs = data.recordingEndMs;
    this.Consultation = data.Consultation;
  }
}
