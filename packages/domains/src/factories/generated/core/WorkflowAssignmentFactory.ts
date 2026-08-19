/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { WorkflowAssignmentEntity, IWorkflowAssignmentEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateWorkflowAssignmentProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowAssignmentEntity['tenantId'];
  scope: IWorkflowAssignmentEntity['scope'];
  scopeId?: IWorkflowAssignmentEntity['scopeId'];
  paletteKey: IWorkflowAssignmentEntity['paletteKey'];
  workflowDefinitionSlug: IWorkflowAssignmentEntity['workflowDefinitionSlug'];

  createdAt?: IWorkflowAssignmentEntity['createdAt'];
  updatedAt?: IWorkflowAssignmentEntity['updatedAt'];
  createdBy?: IWorkflowAssignmentEntity['createdBy'];
  updatedBy?: IWorkflowAssignmentEntity['updatedBy'];
}

export class WorkflowAssignmentFactory {
  static CreateWorkflowAssignment(props: CreateWorkflowAssignmentProps): WorkflowAssignmentEntity {
    const id = generateId();
    const now = new Date();

    return new WorkflowAssignmentEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      scope: props.scope,
      scopeId: props.scopeId ?? null,
      paletteKey: props.paletteKey,
      workflowDefinitionSlug: props.workflowDefinitionSlug,
    });
  }
}
