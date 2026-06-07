/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { HarnessPolicyChangeEntity, IHarnessPolicyChangeEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateHarnessPolicyChangeProps extends BaseEntityFactoryCreateProps {
  tenantId: IHarnessPolicyChangeEntity['tenantId'];
  Tenant?: IHarnessPolicyChangeEntity['Tenant'];

  changedBy?: IHarnessPolicyChangeEntity['changedBy'];
  policyVersion?: IHarnessPolicyChangeEntity['policyVersion'];
  /** Null when this change CREATED the policy row. */
  beforeJson?: IHarnessPolicyChangeEntity['beforeJson'];
  afterJson: IHarnessPolicyChangeEntity['afterJson'];
  reason?: IHarnessPolicyChangeEntity['reason'];

  createdAt?: IHarnessPolicyChangeEntity['createdAt'];
  createdBy?: IHarnessPolicyChangeEntity['createdBy'];
}

export class HarnessPolicyChangeFactory {
  /**
   * Build an append-only policy-change record (before/after snapshot of a
   * single edit). Immutable once persisted (WORM); the service writes one of
   * these for every `updatePolicy` / `updateGlobalDefault` call.
   */
  static CreateHarnessPolicyChange(props: CreateHarnessPolicyChangeProps): HarnessPolicyChangeEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new HarnessPolicyChangeEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      changedBy: props.changedBy ?? null,
      policyVersion: props.policyVersion ?? null,
      beforeJson: props.beforeJson ?? null,
      afterJson: props.afterJson,
      reason: props.reason ?? null,

      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
