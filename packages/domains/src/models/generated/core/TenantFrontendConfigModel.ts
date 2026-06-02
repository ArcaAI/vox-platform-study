/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantFrontendConfig extends BaseTenantDataModel {
  public asrModel: string | null;
  public noiseCancel: boolean;
  public vad: boolean;
  public voiceEnrollment: boolean;
  public diarization: boolean;
  public configJson: any | null;

  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantFrontendConfig & BaseTenantDataModel) {
    super(data);
    this.asrModel = data.asrModel;
    this.noiseCancel = data.noiseCancel;
    this.vad = data.vad;
    this.voiceEnrollment = data.voiceEnrollment;
    this.diarization = data.diarization;
    this.configJson = data.configJson;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
