/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AgentAssignmentEntity, IAgentAssignmentEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAgentAssignmentProps extends BaseEntityFactoryCreateProps {
  tenantId: IAgentAssignmentEntity['tenantId'];
  scope: IAgentAssignmentEntity['scope'];
  scopeId?: IAgentAssignmentEntity['scopeId'];
  task: IAgentAssignmentEntity['task'];
  agentSlug: IAgentAssignmentEntity['agentSlug'];
  /** Canonical `key:value` tag selector; omitted / `''` = the tier's unqualified assignment. */
  selectorKey?: IAgentAssignmentEntity['selectorKey'];

  createdAt?: IAgentAssignmentEntity['createdAt'];
  updatedAt?: IAgentAssignmentEntity['updatedAt'];
  createdBy?: IAgentAssignmentEntity['createdBy'];
  updatedBy?: IAgentAssignmentEntity['updatedBy'];
}

export class AgentAssignmentFactory {
  static CreateAgentAssignment(props: CreateAgentAssignmentProps): AgentAssignmentEntity {
    const id = generateId();
    const now = new Date();

    return new AgentAssignmentEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      scope: props.scope,
      scopeId: props.scopeId ?? null,
      task: props.task,
      agentSlug: props.agentSlug,
      selectorKey: props.selectorKey ?? '',
    });
  }
}
