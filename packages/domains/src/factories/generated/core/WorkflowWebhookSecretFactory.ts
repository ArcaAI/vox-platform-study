/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { IWorkflowWebhookSecretEntity, WorkflowWebhookSecretEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateWorkflowWebhookSecretProps extends BaseEntityFactoryCreateProps {
  tenantId: IWorkflowWebhookSecretEntity['tenantId'];
  workflowSlug: IWorkflowWebhookSecretEntity['workflowSlug'];
  encryptedSecret: IWorkflowWebhookSecretEntity['encryptedSecret'];
  rotatedAt?: IWorkflowWebhookSecretEntity['rotatedAt'];

  createdAt?: IWorkflowWebhookSecretEntity['createdAt'];
  updatedAt?: IWorkflowWebhookSecretEntity['updatedAt'];
  createdBy?: IWorkflowWebhookSecretEntity['createdBy'];
  updatedBy?: IWorkflowWebhookSecretEntity['updatedBy'];
}

export class WorkflowWebhookSecretFactory {
  static CreateWorkflowWebhookSecret(props: CreateWorkflowWebhookSecretProps): WorkflowWebhookSecretEntity {
    const id = generateId();
    const now = new Date();

    return new WorkflowWebhookSecretEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      workflowSlug: props.workflowSlug,
      encryptedSecret: props.encryptedSecret,
      rotatedAt: props.rotatedAt ?? now,
    });
  }
}
