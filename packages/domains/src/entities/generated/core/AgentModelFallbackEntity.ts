/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * TASK-863 — one link of an agent version's ordered fallback chain. Real FKs
 * on both ends (ticket decision D-3); the chain belongs to its agent VERSION
 * row and is immutable once that row is published (DB trigger).
 */
export interface IAgentModelFallbackEntity extends IBaseTenantEntity {
  agentId: string;
  priority: number;
  modelId: string;
  enabled: boolean;
}

export class AgentModelFallbackEntity extends BaseTenantEntity {
  private _agentId: IAgentModelFallbackEntity['agentId'];
  private _priority: IAgentModelFallbackEntity['priority'];
  private _modelId: IAgentModelFallbackEntity['modelId'];
  private _enabled: IAgentModelFallbackEntity['enabled'];

  constructor(init: IAgentModelFallbackEntity) {
    super(init);
    this._agentId = init.agentId;
    this._priority = init.priority;
    this._modelId = init.modelId;
    this._enabled = init.enabled;
  }

  get agentId(): IAgentModelFallbackEntity['agentId'] {
    return this._agentId;
  }

  set agentId(value: IAgentModelFallbackEntity['agentId']) {
    this.setProperty('agentId', value);
  }

  get priority(): IAgentModelFallbackEntity['priority'] {
    return this._priority;
  }

  set priority(value: IAgentModelFallbackEntity['priority']) {
    this.setProperty('priority', value);
  }

  get modelId(): IAgentModelFallbackEntity['modelId'] {
    return this._modelId;
  }

  set modelId(value: IAgentModelFallbackEntity['modelId']) {
    this.setProperty('modelId', value);
  }

  get enabled(): IAgentModelFallbackEntity['enabled'] {
    return this._enabled;
  }

  set enabled(value: IAgentModelFallbackEntity['enabled']) {
    this.setProperty('enabled', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._agentId || this._agentId.trim().length === 0) {
      throw new BusinessException('AgentModelFallback agentId is required.');
    }
    if (!this._modelId || this._modelId.trim().length === 0) {
      throw new BusinessException('AgentModelFallback modelId is required.');
    }
    if (!Number.isInteger(this._priority) || this._priority < 0) {
      throw new BusinessException('AgentModelFallback priority must be a non-negative integer.');
    }
  }
}
