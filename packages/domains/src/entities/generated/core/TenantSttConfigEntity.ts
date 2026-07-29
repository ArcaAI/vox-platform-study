/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

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
}

export class TenantSttConfigEntity extends BaseTenantEntity {
  private _fallbackPipelineId?: ITenantSttConfigEntity['fallbackPipelineId'];
  private _autoSwitchEnabled: ITenantSttConfigEntity['autoSwitchEnabled'];
  private _configJson?: ITenantSttConfigEntity['configJson'];

  constructor(init: ITenantSttConfigEntity) {
    super(init);
    this._fallbackPipelineId = init.fallbackPipelineId;
    this._autoSwitchEnabled = init.autoSwitchEnabled;
    this._configJson = init.configJson;
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
}
