/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { AiTaskKind } from '../../../enums';

// One row per tenant (SYSTEM tenant = platform default). Nullable fields mean
// "inherit from the SYSTEM default / code default"; the application resolver
// merges the tenant row over the SYSTEM default field-by-field.
// `fallbackPipelineId` is the tenant-level default fallback pipeline pointer
// (validated in the service: tenant-visible, ENABLED, cloud-engine-backed);
// `autoSwitchEnabled` is the tenant kill-switch for the error-triggered
// auto-switch (default ON).
export interface ITenantSttConfigEntity extends IBaseTenantEntity {
  fallbackPipelineId?: string | null;
  autoSwitchEnabled: boolean;
  configJson?: Record<string, unknown> | null;
  // CONSTANT for the model: every row is a speech-to-text binding.
  // Optional on the interface so the create path can omit it (the DB default
  // covers it); non-optional on the class with the matching code default.
  taskKind?: AiTaskKind;
}

export class TenantSttConfigEntity extends BaseTenantEntity {
  private _fallbackPipelineId?: ITenantSttConfigEntity['fallbackPipelineId'];
  private _autoSwitchEnabled: ITenantSttConfigEntity['autoSwitchEnabled'];
  private _configJson?: ITenantSttConfigEntity['configJson'];
  private _taskKind: AiTaskKind;

  constructor(init: ITenantSttConfigEntity) {
    super(init);
    this._fallbackPipelineId = init.fallbackPipelineId;
    this._autoSwitchEnabled = init.autoSwitchEnabled;
    this._configJson = init.configJson;
    this._taskKind = init.taskKind ?? AiTaskKind.SPEECH_TO_TEXT;
  }

  get fallbackPipelineId(): ITenantSttConfigEntity['fallbackPipelineId'] {
    return this._fallbackPipelineId;
  }

  set fallbackPipelineId(value: ITenantSttConfigEntity['fallbackPipelineId']) {
    this.setProperty('fallbackPipelineId', value);
  }

  get autoSwitchEnabled(): ITenantSttConfigEntity['autoSwitchEnabled'] {
    return this._autoSwitchEnabled;
  }

  set autoSwitchEnabled(value: ITenantSttConfigEntity['autoSwitchEnabled']) {
    this.setProperty('autoSwitchEnabled', value);
  }

  get configJson(): ITenantSttConfigEntity['configJson'] {
    return this._configJson;
  }

  set configJson(value: ITenantSttConfigEntity['configJson']) {
    this.setProperty('configJson', value);
  }

  get taskKind(): AiTaskKind {
    return this._taskKind;
  }

  set taskKind(value: AiTaskKind) {
    this.setProperty('taskKind', value);
  }
}
