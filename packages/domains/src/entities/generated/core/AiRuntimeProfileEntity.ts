/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// TASK-524 — hyperparameters / context / concurrency per provider
// (`modelSlug = ''`) or per model (`modelSlug = AiModel.slug`, no FK — house
// slug-reference convention).
//
// EVERY numeric field is nullable and null means "no opinion — fall through the
// cascade", NOT "zero". The injection cascade is:
//   explicit request params → AiTaskDefault.configJson
//     → profile(modelSlug) → profile(provider default, '') → service env default
//
// The `''` sentinel for a provider-level default is deliberate: Postgres treats
// NULLs as DISTINCT in unique indexes, so a nullable `modelSlug` would permit
// duplicate provider-default rows.
//
// SYSTEM-tenant-only + global-admin-only enforcement lives in the application
// service (`AiRuntimeProfileService`), as do the numeric range clamps; this
// entity carries only structural invariants.
export interface IAiRuntimeProfileEntity extends IBaseTenantEntity {
  provider: string;
  modelSlug: string;
  temperature?: number | null;
  topP?: number | null;
  maxTokens?: number | null;
  contextLength?: number | null;
  maxConcurrent?: number | null;
  tpmLimit?: number | null;
  rpmLimit?: number | null;
  timeoutS?: number | null;
  keepAliveSeconds?: number | null;
  extraJson?: Record<string, unknown> | null;
}

export class AiRuntimeProfileEntity extends BaseTenantEntity {
  private _provider: IAiRuntimeProfileEntity['provider'];
  private _modelSlug: IAiRuntimeProfileEntity['modelSlug'];
  private _temperature?: IAiRuntimeProfileEntity['temperature'];
  private _topP?: IAiRuntimeProfileEntity['topP'];
  private _maxTokens?: IAiRuntimeProfileEntity['maxTokens'];
  private _contextLength?: IAiRuntimeProfileEntity['contextLength'];
  private _maxConcurrent?: IAiRuntimeProfileEntity['maxConcurrent'];
  private _tpmLimit?: IAiRuntimeProfileEntity['tpmLimit'];
  private _rpmLimit?: IAiRuntimeProfileEntity['rpmLimit'];
  private _timeoutS?: IAiRuntimeProfileEntity['timeoutS'];
  private _keepAliveSeconds?: IAiRuntimeProfileEntity['keepAliveSeconds'];
  private _extraJson?: IAiRuntimeProfileEntity['extraJson'];

  constructor(init: IAiRuntimeProfileEntity) {
    super(init);
    this._provider = init.provider;
    this._modelSlug = init.modelSlug;
    this._temperature = init.temperature;
    this._topP = init.topP;
    this._maxTokens = init.maxTokens;
    this._contextLength = init.contextLength;
    this._maxConcurrent = init.maxConcurrent;
    this._tpmLimit = init.tpmLimit;
    this._rpmLimit = init.rpmLimit;
    this._timeoutS = init.timeoutS;
    this._keepAliveSeconds = init.keepAliveSeconds;
    this._extraJson = init.extraJson;
  }

  get provider(): IAiRuntimeProfileEntity['provider'] {
    return this._provider;
  }

  set provider(value: IAiRuntimeProfileEntity['provider']) {
    this.setProperty('provider', value);
  }

  get modelSlug(): IAiRuntimeProfileEntity['modelSlug'] {
    return this._modelSlug;
  }

  set modelSlug(value: IAiRuntimeProfileEntity['modelSlug']) {
    this.setProperty('modelSlug', value);
  }

  get temperature(): IAiRuntimeProfileEntity['temperature'] {
    return this._temperature;
  }

  set temperature(value: IAiRuntimeProfileEntity['temperature']) {
    this.setProperty('temperature', value);
  }

  get topP(): IAiRuntimeProfileEntity['topP'] {
    return this._topP;
  }

  set topP(value: IAiRuntimeProfileEntity['topP']) {
    this.setProperty('topP', value);
  }

  get maxTokens(): IAiRuntimeProfileEntity['maxTokens'] {
    return this._maxTokens;
  }

  set maxTokens(value: IAiRuntimeProfileEntity['maxTokens']) {
    this.setProperty('maxTokens', value);
  }

  get contextLength(): IAiRuntimeProfileEntity['contextLength'] {
    return this._contextLength;
  }

  set contextLength(value: IAiRuntimeProfileEntity['contextLength']) {
    this.setProperty('contextLength', value);
  }

  get maxConcurrent(): IAiRuntimeProfileEntity['maxConcurrent'] {
    return this._maxConcurrent;
  }

  set maxConcurrent(value: IAiRuntimeProfileEntity['maxConcurrent']) {
    this.setProperty('maxConcurrent', value);
  }

  get tpmLimit(): IAiRuntimeProfileEntity['tpmLimit'] {
    return this._tpmLimit;
  }

  set tpmLimit(value: IAiRuntimeProfileEntity['tpmLimit']) {
    this.setProperty('tpmLimit', value);
  }

  get rpmLimit(): IAiRuntimeProfileEntity['rpmLimit'] {
    return this._rpmLimit;
  }

  set rpmLimit(value: IAiRuntimeProfileEntity['rpmLimit']) {
    this.setProperty('rpmLimit', value);
  }

  get timeoutS(): IAiRuntimeProfileEntity['timeoutS'] {
    return this._timeoutS;
  }

  set timeoutS(value: IAiRuntimeProfileEntity['timeoutS']) {
    this.setProperty('timeoutS', value);
  }

  get keepAliveSeconds(): IAiRuntimeProfileEntity['keepAliveSeconds'] {
    return this._keepAliveSeconds;
  }

  set keepAliveSeconds(value: IAiRuntimeProfileEntity['keepAliveSeconds']) {
    this.setProperty('keepAliveSeconds', value);
  }

  get extraJson(): IAiRuntimeProfileEntity['extraJson'] {
    return this._extraJson;
  }

  set extraJson(value: IAiRuntimeProfileEntity['extraJson']) {
    this.setProperty('extraJson', value);
  }

  /** True for the provider-level default row (the `''` modelSlug sentinel). */
  get isProviderDefault(): boolean {
    return this._modelSlug === '';
  }

  public override validate(): void {
    super.validate();
    if (!this._provider || this._provider.trim().length === 0) {
      throw new BusinessException('Provider is required');
    }
    // `modelSlug` may be '' (the provider-default sentinel) but never null/undefined —
    // the compound unique index depends on a non-null value.
    if (this._modelSlug == null) {
      throw new BusinessException('Model slug is required (use "" for the provider-level default)');
    }
  }
}
