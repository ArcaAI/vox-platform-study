/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// TASK-496 — one row per tenant (SYSTEM tenant = platform default). Nullable /
// empty-array fields mean "inherit from the SYSTEM default / code default"; the
// application resolver merges + clamps to PLATFORM_TTS_LIMITS.
export interface ITenantTtsConfigEntity extends IBaseTenantEntity {
  defaultVoiceEn?: string | null;
  defaultVoiceMl?: string | null;
  routingEn: string[];
  routingMl: string[];
  allowedProviders: string[];
  defaultFormat?: string | null;
  defaultSpeed?: number | null;
  sampleRate?: number | null;
  maxInputChars?: number | null;
  sarvamPublicApiAllowed: boolean;
  configJson?: Record<string, unknown> | null;
}

export class TenantTtsConfigEntity extends BaseTenantEntity {
  private _defaultVoiceEn?: ITenantTtsConfigEntity['defaultVoiceEn'];
  private _defaultVoiceMl?: ITenantTtsConfigEntity['defaultVoiceMl'];
  private _routingEn: ITenantTtsConfigEntity['routingEn'];
  private _routingMl: ITenantTtsConfigEntity['routingMl'];
  private _allowedProviders: ITenantTtsConfigEntity['allowedProviders'];
  private _defaultFormat?: ITenantTtsConfigEntity['defaultFormat'];
  private _defaultSpeed?: ITenantTtsConfigEntity['defaultSpeed'];
  private _sampleRate?: ITenantTtsConfigEntity['sampleRate'];
  private _maxInputChars?: ITenantTtsConfigEntity['maxInputChars'];
  private _sarvamPublicApiAllowed: ITenantTtsConfigEntity['sarvamPublicApiAllowed'];
  private _configJson?: ITenantTtsConfigEntity['configJson'];

  constructor(init: ITenantTtsConfigEntity) {
    super(init);
    this._defaultVoiceEn = init.defaultVoiceEn;
    this._defaultVoiceMl = init.defaultVoiceMl;
    this._routingEn = init.routingEn;
    this._routingMl = init.routingMl;
    this._allowedProviders = init.allowedProviders;
    this._defaultFormat = init.defaultFormat;
    this._defaultSpeed = init.defaultSpeed;
    this._sampleRate = init.sampleRate;
    this._maxInputChars = init.maxInputChars;
    this._sarvamPublicApiAllowed = init.sarvamPublicApiAllowed;
    this._configJson = init.configJson;
  }

  get defaultVoiceEn(): ITenantTtsConfigEntity['defaultVoiceEn'] {
    return this._defaultVoiceEn;
  }

  set defaultVoiceEn(value: ITenantTtsConfigEntity['defaultVoiceEn']) {
    this.setProperty('defaultVoiceEn', value);
  }

  get defaultVoiceMl(): ITenantTtsConfigEntity['defaultVoiceMl'] {
    return this._defaultVoiceMl;
  }

  set defaultVoiceMl(value: ITenantTtsConfigEntity['defaultVoiceMl']) {
    this.setProperty('defaultVoiceMl', value);
  }

  get routingEn(): ITenantTtsConfigEntity['routingEn'] {
    return this._routingEn;
  }

  set routingEn(value: ITenantTtsConfigEntity['routingEn']) {
    this.setProperty('routingEn', value);
  }

  get routingMl(): ITenantTtsConfigEntity['routingMl'] {
    return this._routingMl;
  }

  set routingMl(value: ITenantTtsConfigEntity['routingMl']) {
    this.setProperty('routingMl', value);
  }

  get allowedProviders(): ITenantTtsConfigEntity['allowedProviders'] {
    return this._allowedProviders;
  }

  set allowedProviders(value: ITenantTtsConfigEntity['allowedProviders']) {
    this.setProperty('allowedProviders', value);
  }

  get defaultFormat(): ITenantTtsConfigEntity['defaultFormat'] {
    return this._defaultFormat;
  }

  set defaultFormat(value: ITenantTtsConfigEntity['defaultFormat']) {
    this.setProperty('defaultFormat', value);
  }

  get defaultSpeed(): ITenantTtsConfigEntity['defaultSpeed'] {
    return this._defaultSpeed;
  }

  set defaultSpeed(value: ITenantTtsConfigEntity['defaultSpeed']) {
    this.setProperty('defaultSpeed', value);
  }

  get sampleRate(): ITenantTtsConfigEntity['sampleRate'] {
    return this._sampleRate;
  }

  set sampleRate(value: ITenantTtsConfigEntity['sampleRate']) {
    this.setProperty('sampleRate', value);
  }

  get maxInputChars(): ITenantTtsConfigEntity['maxInputChars'] {
    return this._maxInputChars;
  }

  set maxInputChars(value: ITenantTtsConfigEntity['maxInputChars']) {
    this.setProperty('maxInputChars', value);
  }

  get sarvamPublicApiAllowed(): ITenantTtsConfigEntity['sarvamPublicApiAllowed'] {
    return this._sarvamPublicApiAllowed;
  }

  set sarvamPublicApiAllowed(value: ITenantTtsConfigEntity['sarvamPublicApiAllowed']) {
    this.setProperty('sarvamPublicApiAllowed', value);
  }

  get configJson(): ITenantTtsConfigEntity['configJson'] {
    return this._configJson;
  }

  set configJson(value: ITenantTtsConfigEntity['configJson']) {
    this.setProperty('configJson', value);
  }
}
