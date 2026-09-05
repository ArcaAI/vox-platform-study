/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * TASK-863 — WHICH agent serves a task for a scope. `(scope, scopeId)` mirrors
 * `WorkflowAssignment` / `PipelinePolicy` so the resolution is the same
 * first-set-wins `walkCascade`; `agentSlug` is a LINEAGE key resolved to the
 * ACTIVE PUBLISHED version at call time.
 */
export interface IAgentAssignmentEntity extends IBaseTenantEntity {
  scope: Enums.PipelinePolicyScope;
  scopeId?: string | null;
  task: Enums.AgentTask;
  agentSlug: string;
  /**
   * TASK-884 — the canonical (de-duplicated, sorted, comma-joined) `key:value`
   * tag selector this assignment is qualified by; `''` = unqualified. Part of
   * the row's uniqueness key, so a tier can carry one row per selector.
   */
  selectorKey: string;
}

export class AgentAssignmentEntity extends BaseTenantEntity {
  private _scope: IAgentAssignmentEntity['scope'];
  private _scopeId?: IAgentAssignmentEntity['scopeId'];
  private _task: IAgentAssignmentEntity['task'];
  private _agentSlug: IAgentAssignmentEntity['agentSlug'];
  private _selectorKey: IAgentAssignmentEntity['selectorKey'];

  constructor(init: IAgentAssignmentEntity) {
    super(init);
    this._scope = init.scope;
    this._scopeId = init.scopeId;
    this._task = init.task;
    this._agentSlug = init.agentSlug;
    this._selectorKey = init.selectorKey ?? '';
  }

  get scope(): IAgentAssignmentEntity['scope'] {
    return this._scope;
  }

  set scope(value: IAgentAssignmentEntity['scope']) {
    this.setProperty('scope', value);
  }

  get scopeId(): IAgentAssignmentEntity['scopeId'] {
    return this._scopeId;
  }

  set scopeId(value: IAgentAssignmentEntity['scopeId']) {
    this.setProperty('scopeId', value);
  }

  get task(): IAgentAssignmentEntity['task'] {
    return this._task;
  }

  set task(value: IAgentAssignmentEntity['task']) {
    this.setProperty('task', value);
  }

  get selectorKey(): IAgentAssignmentEntity['selectorKey'] {
    return this._selectorKey;
  }

  set selectorKey(value: IAgentAssignmentEntity['selectorKey']) {
    this.setProperty('selectorKey', value);
  }

  get agentSlug(): IAgentAssignmentEntity['agentSlug'] {
    return this._agentSlug;
  }

  set agentSlug(value: IAgentAssignmentEntity['agentSlug']) {
    this.setProperty('agentSlug', value);
  }

  public override validate(): void {
    super.validate();
    if (this._task === undefined || this._task === null) {
      throw new BusinessException('AgentAssignment task is required.');
    }
    if (!this._agentSlug || this._agentSlug.trim().length === 0) {
      throw new BusinessException('AgentAssignment agentSlug is required.');
    }
    if (this._scope === Enums.PipelinePolicyScope.TENANT) {
      if (this._scopeId) {
        throw new BusinessException('A TENANT-scope AgentAssignment must not carry a scopeId.');
      }
    } else if (!this._scopeId) {
      throw new BusinessException(`A ${this._scope}-scope AgentAssignment requires a scopeId.`);
    }
  }
}
