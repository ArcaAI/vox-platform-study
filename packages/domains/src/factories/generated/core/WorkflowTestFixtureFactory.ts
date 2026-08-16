/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { WorkflowTestFixtureEntity, IWorkflowTestFixtureEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateWorkflowTestFixtureProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowTestFixtureEntity['tenantId'];
  name: IWorkflowTestFixtureEntity['name'];
  description?: IWorkflowTestFixtureEntity['description'];
  paletteId?: IWorkflowTestFixtureEntity['paletteId'];
  workflowDefinitionId?: IWorkflowTestFixtureEntity['workflowDefinitionId'];
  input: IWorkflowTestFixtureEntity['input'];

  createdAt?: IWorkflowTestFixtureEntity['createdAt'];
  updatedAt?: IWorkflowTestFixtureEntity['updatedAt'];
  createdBy?: IWorkflowTestFixtureEntity['createdBy'];
  updatedBy?: IWorkflowTestFixtureEntity['updatedBy'];
}

export class WorkflowTestFixtureFactory {
  static CreateWorkflowTestFixture(props: CreateWorkflowTestFixtureProps): WorkflowTestFixtureEntity {
    const id = generateId();
    const now = new Date();

    return new WorkflowTestFixtureEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      name: props.name,
      description: props.description ?? null,
      paletteId: props.paletteId ?? null,
      workflowDefinitionId: props.workflowDefinitionId ?? null,
      input: props.input,
    });
  }
}
