/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantGuardrailPolicyEntity, TenantGuardrailPolicyEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantGuardrailPolicyProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantGuardrailPolicyEntity['tenantId'];
  policies?: ITenantGuardrailPolicyEntity['policies'];
  reason?: ITenantGuardrailPolicyEntity['reason'];

  createdAt?: ITenantGuardrailPolicyEntity['createdAt'];
  updatedAt?: ITenantGuardrailPolicyEntity['updatedAt'];
  createdBy?: ITenantGuardrailPolicyEntity['createdBy'];
  updatedBy?: ITenantGuardrailPolicyEntity['updatedBy'];
}

export class TenantGuardrailPolicyFactory {
  static CreateTenantGuardrailPolicy(props: CreateTenantGuardrailPolicyProps): TenantGuardrailPolicyEntity {
    const id = generateId();
    const now = new Date();

    return new TenantGuardrailPolicyEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      // `{}` — not a copy of the platform set. A row that restates SYSTEM's
      // selection would stop tracking it: the platform adding a NINTH check
      // would reach every tenant except the ones whose rows had snapshotted the
      // eight. Absence is how a tenant follows the platform.
      policies: props.policies ?? {},
      reason: props.reason ?? null,
    });
  }
}
