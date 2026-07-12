/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TenantTtsConfig extends BaseTenantDataModel {
  public defaultVoiceEn: string | null;
  public defaultVoiceMl: string | null;
  public routingEn: string[];
  public routingMl: string[];
  public allowedProviders: string[];
  public defaultFormat: string | null;
  public defaultSpeed: number | null;
  public sampleRate: number | null;
  public maxInputChars: number | null;
  public sarvamPublicApiAllowed: boolean;
  public configJson: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: TenantTtsConfig & BaseTenantDataModel) {
    super(data);
    this.defaultVoiceEn = data.defaultVoiceEn;
    this.defaultVoiceMl = data.defaultVoiceMl;
    this.routingEn = data.routingEn;
    this.routingMl = data.routingMl;
    this.allowedProviders = data.allowedProviders;
    this.defaultFormat = data.defaultFormat;
    this.defaultSpeed = data.defaultSpeed;
    this.sampleRate = data.sampleRate;
    this.maxInputChars = data.maxInputChars;
    this.sarvamPublicApiAllowed = data.sarvamPublicApiAllowed;
    this.configJson = data.configJson;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
