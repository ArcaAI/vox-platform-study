/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsentGrantEntity, IConsentGrantEntity } from '../../../entities';
import { generateId } from '../../../utils';

// HAND-AUTHORED — TASK-712 (consent-abac). `gen:entity`/`gen:factory`
// reconcile against committed source; they do not scaffold (see
// .claude/rules/03-domain-layer.md). Follows AiProviderConnectionFactory.
export interface CreateConsentGrantProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsentGrantEntity['tenantId'];
  externalPatientId: IConsentGrantEntity['externalPatientId'];
  purpose: IConsentGrantEntity['purpose'];
  scope?: IConsentGrantEntity['scope'];
  grantedAt?: IConsentGrantEntity['grantedAt'];
  grantedBy: IConsentGrantEntity['grantedBy'];
  grantMethod: IConsentGrantEntity['grantMethod'];
  evidenceRef?: IConsentGrantEntity['evidenceRef'];
  expiresAt?: IConsentGrantEntity['expiresAt'];

  createdAt?: IConsentGrantEntity['createdAt'];
  updatedAt?: IConsentGrantEntity['updatedAt'];
  createdBy?: IConsentGrantEntity['createdBy'];
  updatedBy?: IConsentGrantEntity['updatedBy'];
}

export class ConsentGrantFactory {
  static CreateConsentGrant(props: CreateConsentGrantProps): ConsentGrantEntity {
    const id = generateId();
    const now = new Date();

    return new ConsentGrantEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      externalPatientId: props.externalPatientId,
      purpose: props.purpose,
      scope: props.scope ?? null,
      grantedAt: props.grantedAt ?? now,
      grantedBy: props.grantedBy,
      grantMethod: props.grantMethod,
      evidenceRef: props.evidenceRef ?? null,
      expiresAt: props.expiresAt ?? null,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
    });
  }
}
