/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantFrontendConfig extends BaseTenantDataModel {
  public captureRawAudio: boolean;
  public transcriptionMode: Enums.TranscriptionMode;
  public transcriptionModeLocked: boolean;
  public captureMode: Enums.CaptureMode | null;
  public configJson: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantFrontendConfig & BaseTenantDataModel) {
    super(data);
    this.captureRawAudio = data.captureRawAudio;
    this.transcriptionMode = data.transcriptionMode;
    this.transcriptionModeLocked = data.transcriptionModeLocked;
    this.captureMode = data.captureMode;
    this.configJson = data.configJson;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
