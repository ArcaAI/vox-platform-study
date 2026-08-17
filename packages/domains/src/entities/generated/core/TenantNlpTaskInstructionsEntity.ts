/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Tenant-writable instruction content for the open-taxonomy `nlp.topic` /
// `nlp.intent` task types (TASK-729). One row per (tenant, taskKey);
// `instructionsJson` carries only tenant-authored instruction content (topic
// list / intent list / free-text guidance) — deliberately NEVER a modelSlug.
// Model/provider SELECTION for these task types still resolves through
// AiTaskDefault under its existing super-admin-only `nlp.*` lock; this
// entity carries only structural invariants, the `nlp.topic`/`nlp.intent`
// taskKey restriction lives in the application service.
export interface ITenantNlpTaskInstructionsEntity extends IBaseTenantEntity {
  taskKey: string;
  instructionsJson?: Record<string, unknown> | unknown[] | null;
}

export class TenantNlpTaskInstructionsEntity extends BaseTenantEntity {
  private _taskKey: ITenantNlpTaskInstructionsEntity['taskKey'];
  private _instructionsJson?: ITenantNlpTaskInstructionsEntity['instructionsJson'];

  constructor(init: ITenantNlpTaskInstructionsEntity) {
    super(init);
    this._taskKey = init.taskKey;
    this._instructionsJson = init.instructionsJson;
  }

  get taskKey(): ITenantNlpTaskInstructionsEntity['taskKey'] {
    return this._taskKey;
  }

  set taskKey(value: ITenantNlpTaskInstructionsEntity['taskKey']) {
    this.setProperty('taskKey', value);
  }

  get instructionsJson(): ITenantNlpTaskInstructionsEntity['instructionsJson'] {
    return this._instructionsJson;
  }

  set instructionsJson(value: ITenantNlpTaskInstructionsEntity['instructionsJson']) {
    this.setProperty('instructionsJson', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._taskKey || this._taskKey.trim().length === 0) {
      throw new BusinessException('Task key is required');
    }
  }
}
