/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

export interface ITenantFrontendConfigEntity extends IBaseTenantEntity {
  captureRawAudio: boolean;
  transcriptionMode: Enums.TranscriptionMode;
  transcriptionModeLocked: boolean;
  captureMode?: Enums.CaptureMode | null;
  configJson?: Record<string, unknown> | null;
}

export class TenantFrontendConfigEntity extends BaseTenantEntity {
  private _captureRawAudio: ITenantFrontendConfigEntity['captureRawAudio'];
  private _transcriptionMode: ITenantFrontendConfigEntity['transcriptionMode'];
  private _transcriptionModeLocked: ITenantFrontendConfigEntity['transcriptionModeLocked'];
  private _captureMode?: ITenantFrontendConfigEntity['captureMode'];
  private _configJson?: ITenantFrontendConfigEntity['configJson'];

  constructor(init: ITenantFrontendConfigEntity) {
    super(init);
    this._captureRawAudio = init.captureRawAudio;
    this._transcriptionMode = init.transcriptionMode;
    this._transcriptionModeLocked = init.transcriptionModeLocked;
    this._captureMode = init.captureMode;
    this._configJson = init.configJson;
  }

  get captureRawAudio(): ITenantFrontendConfigEntity['captureRawAudio'] {
    return this._captureRawAudio;
  }

  set captureRawAudio(value: ITenantFrontendConfigEntity['captureRawAudio']) {
    this.setProperty('captureRawAudio', value);
  }

  get transcriptionMode(): ITenantFrontendConfigEntity['transcriptionMode'] {
    return this._transcriptionMode;
  }

  set transcriptionMode(value: ITenantFrontendConfigEntity['transcriptionMode']) {
    this.setProperty('transcriptionMode', value);
  }

  get transcriptionModeLocked(): ITenantFrontendConfigEntity['transcriptionModeLocked'] {
    return this._transcriptionModeLocked;
  }

  set transcriptionModeLocked(value: ITenantFrontendConfigEntity['transcriptionModeLocked']) {
    this.setProperty('transcriptionModeLocked', value);
  }

  get captureMode(): ITenantFrontendConfigEntity['captureMode'] {
    return this._captureMode;
  }

  set captureMode(value: ITenantFrontendConfigEntity['captureMode']) {
    this.setProperty('captureMode', value);
  }

  get configJson(): ITenantFrontendConfigEntity['configJson'] {
    return this._configJson;
  }

  set configJson(value: ITenantFrontendConfigEntity['configJson']) {
    this.setProperty('configJson', value);
  }
}
