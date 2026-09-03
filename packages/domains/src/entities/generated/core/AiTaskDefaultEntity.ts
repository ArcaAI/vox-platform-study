/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { AiTaskKind } from '../../../enums';

// Per-tenant "default model for task X" selector: one row per
// (tenant, taskKey); the reserved SYSTEM tenant row is the platform default.
// `modelSlug` references AiModel.slug within [tenant, SYSTEM] scope (no FK —
// house convention). Resolution (tenant row → SYSTEM row → service env
// fallback) and taskKey/slug compatibility validation live in the application
// service (`AiTaskDefaultService`); this entity carries only structural
// invariants.
export interface IAiTaskDefaultEntity extends IBaseTenantEntity {
  taskKey: string;
  modelSlug: string;
  configJson?: Record<string, unknown> | null;
  // the canonical task taxonomy `taskKey` belongs to, DERIVED from
  // it via `AI_TASK_KIND_BY_TASK_KEY` in the applications layer. Optional here
  // because Phase 1 is additive and no writer sets it yet; makes it
  // required once `AiTaskDefaultService.upsertRow` does.
  taskKind?: AiTaskKind | null;
}

export class AiTaskDefaultEntity extends BaseTenantEntity {
  private _taskKey: IAiTaskDefaultEntity['taskKey'];
  private _modelSlug: IAiTaskDefaultEntity['modelSlug'];
  private _configJson?: IAiTaskDefaultEntity['configJson'];
  private _taskKind?: IAiTaskDefaultEntity['taskKind'];

  constructor(init: IAiTaskDefaultEntity) {
    super(init);
    this._taskKey = init.taskKey;
    this._modelSlug = init.modelSlug;
    this._configJson = init.configJson;
    this._taskKind = init.taskKind;
  }

  get taskKey(): IAiTaskDefaultEntity['taskKey'] {
    return this._taskKey;
  }

  set taskKey(value: IAiTaskDefaultEntity['taskKey']) {
    this.setProperty('taskKey', value);
  }

  get modelSlug(): IAiTaskDefaultEntity['modelSlug'] {
    return this._modelSlug;
  }

  set modelSlug(value: IAiTaskDefaultEntity['modelSlug']) {
    this.setProperty('modelSlug', value);
  }

  get configJson(): IAiTaskDefaultEntity['configJson'] {
    return this._configJson;
  }

  set configJson(value: IAiTaskDefaultEntity['configJson']) {
    this.setProperty('configJson', value);
  }

  get taskKind(): IAiTaskDefaultEntity['taskKind'] {
    return this._taskKind;
  }

  set taskKind(value: IAiTaskDefaultEntity['taskKind']) {
    this.setProperty('taskKind', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._taskKey || this._taskKey.trim().length === 0) {
      throw new BusinessException('Task key is required');
    }
    if (!this._modelSlug || this._modelSlug.trim().length === 0) {
      throw new BusinessException('Model slug is required');
    }
  }
}
