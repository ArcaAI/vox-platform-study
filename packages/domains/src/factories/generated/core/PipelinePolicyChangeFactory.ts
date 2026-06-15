/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PipelinePolicyChangeEntity, IPipelinePolicyChangeEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreatePipelinePolicyChangeProps extends BaseEntityFactoryCreateProps {
  tenantId: IPipelinePolicyChangeEntity['tenantId'];
  Tenant?: IPipelinePolicyChangeEntity['Tenant'];

  scope: IPipelinePolicyChangeEntity['scope'];
  scopeId?: IPipelinePolicyChangeEntity['scopeId'];
  changedBy?: IPipelinePolicyChangeEntity['changedBy'];
  policyVersion?: IPipelinePolicyChangeEntity['policyVersion'];
  /** Null when this change CREATED the policy row. */
  beforeJson?: IPipelinePolicyChangeEntity['beforeJson'];
  afterJson: IPipelinePolicyChangeEntity['afterJson'];
  reason?: IPipelinePolicyChangeEntity['reason'];

  createdAt?: IPipelinePolicyChangeEntity['createdAt'];
  createdBy?: IPipelinePolicyChangeEntity['createdBy'];
}

export class PipelinePolicyChangeFactory {
  /**
   * Build an append-only policy-change record (before/after snapshot of a
   * single edit). Immutable once persisted (WORM); the service writes one of
   * these for every policy create/update call.
   */
  static CreatePipelinePolicyChange(props: CreatePipelinePolicyChangeProps): PipelinePolicyChangeEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new PipelinePolicyChangeEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      scope: props.scope,
      scopeId: props.scopeId ?? null,
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
