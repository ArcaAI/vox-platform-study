/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiRuntimeProfile extends BaseTenantDataModel {
  public provider: string;
  public modelSlug: string;
  public temperature: number | null;
  public topP: number | null;
  public maxTokens: number | null;
  public contextLength: number | null;
  public maxConcurrent: number | null;
  public tpmLimit: number | null;
  public rpmLimit: number | null;
  public timeoutS: number | null;
  public keepAliveSeconds: number | null;
  public extraJson: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: AiRuntimeProfile & BaseTenantDataModel) {
    super(data);
    this.provider = data.provider;
    this.modelSlug = data.modelSlug;
    this.temperature = data.temperature;
    this.topP = data.topP;
    this.maxTokens = data.maxTokens;
    this.contextLength = data.contextLength;
    this.maxConcurrent = data.maxConcurrent;
    this.tpmLimit = data.tpmLimit;
    this.rpmLimit = data.rpmLimit;
    this.timeoutS = data.timeoutS;
    this.keepAliveSeconds = data.keepAliveSeconds;
    this.extraJson = data.extraJson;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
