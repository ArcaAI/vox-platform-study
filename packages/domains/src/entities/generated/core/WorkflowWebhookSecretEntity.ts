/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// TASK-864 — the INBOUND workflow webhook trigger's per-definition HMAC secret, keyed
// (tenantId, workflowSlug): the LINEAGE, so a republish does not rotate every integrator's
// key. `encryptedSecret` is AES-256-GCM ciphertext under the dedicated webhook pepper
// (`WebhookService.encryptSecret`) — REVERSIBLE on purpose, because an HMAC verifier must
// recover the key; a one-way hash cannot verify a signature. The entity never sees plaintext
// and no read DTO carries the ciphertext. Rotation is audited on the `WorkflowDefinition`
// lineage, so this model carries no `ResourceType` of its own.
export interface IWorkflowWebhookSecretEntity extends IBaseTenantEntity {
  workflowSlug: string;
  encryptedSecret: string;
  rotatedAt: Date;
}

export class WorkflowWebhookSecretEntity extends BaseTenantEntity {
  private _workflowSlug: IWorkflowWebhookSecretEntity['workflowSlug'];
  private _encryptedSecret: IWorkflowWebhookSecretEntity['encryptedSecret'];
  private _rotatedAt: IWorkflowWebhookSecretEntity['rotatedAt'];

  constructor(init: IWorkflowWebhookSecretEntity) {
    super(init);
    this._workflowSlug = init.workflowSlug;
    this._encryptedSecret = init.encryptedSecret;
    this._rotatedAt = init.rotatedAt;
  }

  get workflowSlug(): IWorkflowWebhookSecretEntity['workflowSlug'] {
    return this._workflowSlug;
  }

  set workflowSlug(value: IWorkflowWebhookSecretEntity['workflowSlug']) {
    this.setProperty('workflowSlug', value);
  }

  get encryptedSecret(): IWorkflowWebhookSecretEntity['encryptedSecret'] {
    return this._encryptedSecret;
  }

  set encryptedSecret(value: IWorkflowWebhookSecretEntity['encryptedSecret']) {
    this.setProperty('encryptedSecret', value);
  }

  get rotatedAt(): IWorkflowWebhookSecretEntity['rotatedAt'] {
    return this._rotatedAt;
  }

  set rotatedAt(value: IWorkflowWebhookSecretEntity['rotatedAt']) {
    this.setProperty('rotatedAt', value);
  }

  validate(): void {
    if (!this._workflowSlug) {
      throw new BusinessException('WorkflowWebhookSecret.workflowSlug is required');
    }
    if (!this._encryptedSecret) {
      throw new BusinessException('WorkflowWebhookSecret.encryptedSecret is required');
    }
  }
}
