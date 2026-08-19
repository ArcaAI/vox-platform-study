/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { WorkflowAssignmentChangeEntity, IWorkflowAssignmentChangeEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateWorkflowAssignmentChangeProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowAssignmentChangeEntity['tenantId'];
  scope: IWorkflowAssignmentChangeEntity['scope'];
  scopeId?: IWorkflowAssignmentChangeEntity['scopeId'];
  paletteKey: IWorkflowAssignmentChangeEntity['paletteKey'];
  changedBy?: IWorkflowAssignmentChangeEntity['changedBy'];
  assignmentVersion?: IWorkflowAssignmentChangeEntity['assignmentVersion'];
  /** Null when this change CREATED the assignment. */
  beforeSlug?: IWorkflowAssignmentChangeEntity['beforeSlug'];
  /** Null when this change REMOVED the assignment. */
  afterSlug?: IWorkflowAssignmentChangeEntity['afterSlug'];
  reason?: IWorkflowAssignmentChangeEntity['reason'];

  createdAt?: IWorkflowAssignmentChangeEntity['createdAt'];
  createdBy?: IWorkflowAssignmentChangeEntity['createdBy'];
}

export class WorkflowAssignmentChangeFactory {
  /**
   * Build an append-only assignment-change record. Immutable once persisted
   * (WORM); the service writes one for every assignment create/update/delete.
   */
  static CreateWorkflowAssignmentChange(props: CreateWorkflowAssignmentChangeProps): WorkflowAssignmentChangeEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new WorkflowAssignmentChangeEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      scope: props.scope,
      scopeId: props.scopeId ?? null,
      paletteKey: props.paletteKey,
      changedBy: props.changedBy ?? null,
      assignmentVersion: props.assignmentVersion ?? null,
      beforeSlug: props.beforeSlug ?? null,
      afterSlug: props.afterSlug ?? null,
      reason: props.reason ?? null,
    });
  }
}
