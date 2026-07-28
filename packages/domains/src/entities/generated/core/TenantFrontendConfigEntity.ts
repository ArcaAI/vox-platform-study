/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

export interface ITenantFrontendConfigEntity extends IBaseTenantEntity {
  asrModel?: string | null;
  noiseCancel: boolean;
  vad: boolean;
  voiceEnrollment: boolean;
  diarization: boolean;
  captureRawAudio: boolean;
  transcriptionMode: Enums.TranscriptionMode;
  transcriptionModeLocked: boolean;
  captureMode?: Enums.CaptureMode | null;
  configJson?: Record<string, unknown> | null;
}

export class TenantFrontendConfigEntity extends BaseTenantEntity {
  private _asrModel?: ITenantFrontendConfigEntity['asrModel'];
  private _noiseCancel: ITenantFrontendConfigEntity['noiseCancel'];
  private _vad: ITenantFrontendConfigEntity['vad'];
  private _voiceEnrollment: ITenantFrontendConfigEntity['voiceEnrollment'];
  private _diarization: ITenantFrontendConfigEntity['diarization'];
  private _captureRawAudio: ITenantFrontendConfigEntity['captureRawAudio'];
  private _transcriptionMode: ITenantFrontendConfigEntity['transcriptionMode'];
  private _transcriptionModeLocked: ITenantFrontendConfigEntity['transcriptionModeLocked'];
  private _captureMode?: ITenantFrontendConfigEntity['captureMode'];
  private _configJson?: ITenantFrontendConfigEntity['configJson'];

  constructor(init: ITenantFrontendConfigEntity) {
    super(init);
    this._asrModel = init.asrModel;
    this._noiseCancel = init.noiseCancel;
    this._vad = init.vad;
    this._voiceEnrollment = init.voiceEnrollment;
    this._diarization = init.diarization;
    this._captureRawAudio = init.captureRawAudio;
    this._transcriptionMode = init.transcriptionMode;
    this._transcriptionModeLocked = init.transcriptionModeLocked;
    this._captureMode = init.captureMode;
    this._configJson = init.configJson;
  }

  get asrModel(): ITenantFrontendConfigEntity['asrModel'] {
    return this._asrModel;
  }

  set asrModel(value: ITenantFrontendConfigEntity['asrModel']) {
    this.setProperty('asrModel', value);
  }

  get noiseCancel(): ITenantFrontendConfigEntity['noiseCancel'] {
    return this._noiseCancel;
  }

  set noiseCancel(value: ITenantFrontendConfigEntity['noiseCancel']) {
    this.setProperty('noiseCancel', value);
  }

  get vad(): ITenantFrontendConfigEntity['vad'] {
    return this._vad;
  }

  set vad(value: ITenantFrontendConfigEntity['vad']) {
    this.setProperty('vad', value);
  }

  get voiceEnrollment(): ITenantFrontendConfigEntity['voiceEnrollment'] {
    return this._voiceEnrollment;
  }

  set voiceEnrollment(value: ITenantFrontendConfigEntity['voiceEnrollment']) {
    this.setProperty('voiceEnrollment', value);
  }

  get diarization(): ITenantFrontendConfigEntity['diarization'] {
    return this._diarization;
  }

  set diarization(value: ITenantFrontendConfigEntity['diarization']) {
    this.setProperty('diarization', value);
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
