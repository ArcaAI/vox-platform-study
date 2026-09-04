/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AgentModelFallbackEntity, IAgentModelFallbackEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateAgentModelFallbackProps extends BaseEntityFactoryCreateProps {
  tenantId: IAgentModelFallbackEntity['tenantId'];
  agentId: IAgentModelFallbackEntity['agentId'];
  priority: IAgentModelFallbackEntity['priority'];
  modelId: IAgentModelFallbackEntity['modelId'];
  enabled?: IAgentModelFallbackEntity['enabled'];
  Tenant?: IAgentModelFallbackEntity['Tenant'];

  createdAt?: IAgentModelFallbackEntity['createdAt'];
  createdBy?: IAgentModelFallbackEntity['createdBy'];
}

export class AgentModelFallbackFactory {
  static CreateAgentModelFallback(props: CreateAgentModelFallbackProps): AgentModelFallbackEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AgentModelFallbackEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      agentId: props.agentId,
      priority: props.priority,
      modelId: props.modelId,
      enabled: props.enabled ?? true,
      resourceStatus: props.resourceStatus,
      resourceStatusUpdatedAt: props.resourceStatusUpdatedAt,
      resourceStatusUpdatedBy: props.resourceStatusUpdatedBy,
      Tenant: props.Tenant ?? null,
    });
  }
}
