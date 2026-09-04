/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AgentAssignmentChangeEntity, IAgentAssignmentChangeEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAgentAssignmentChangeProps extends BaseEntityFactoryCreateProps {
  tenantId: IAgentAssignmentChangeEntity['tenantId'];
  scope: IAgentAssignmentChangeEntity['scope'];
  scopeId?: IAgentAssignmentChangeEntity['scopeId'];
  task: IAgentAssignmentChangeEntity['task'];
  changedBy?: IAgentAssignmentChangeEntity['changedBy'];
  assignmentVersion?: IAgentAssignmentChangeEntity['assignmentVersion'];
  /** Null when this change CREATED the assignment. */
  beforeSlug?: IAgentAssignmentChangeEntity['beforeSlug'];
  /** Null when this change REMOVED the assignment. */
  afterSlug?: IAgentAssignmentChangeEntity['afterSlug'];
  reason?: IAgentAssignmentChangeEntity['reason'];

  createdAt?: IAgentAssignmentChangeEntity['createdAt'];
  createdBy?: IAgentAssignmentChangeEntity['createdBy'];
}

export class AgentAssignmentChangeFactory {
  /** Build an append-only assignment-change record (WORM); one per create/update/delete. */
  static CreateAgentAssignmentChange(props: CreateAgentAssignmentChangeProps): AgentAssignmentChangeEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new AgentAssignmentChangeEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      scope: props.scope,
      scopeId: props.scopeId ?? null,
      task: props.task,
      changedBy: props.changedBy ?? null,
      assignmentVersion: props.assignmentVersion ?? null,
      beforeSlug: props.beforeSlug ?? null,
      afterSlug: props.afterSlug ?? null,
      reason: props.reason ?? null,
    });
  }
}
