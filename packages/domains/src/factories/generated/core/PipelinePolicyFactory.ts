/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PipelinePolicyEntity, IPipelinePolicyEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreatePipelinePolicyProps extends BaseEntityFactoryCreateProps {
  tenantId: IPipelinePolicyEntity['tenantId'];
  Tenant?: IPipelinePolicyEntity['Tenant'];

  scope?: IPipelinePolicyEntity['scope'];
  scopeId?: IPipelinePolicyEntity['scopeId'];
  autoSummaryEnabled?: IPipelinePolicyEntity['autoSummaryEnabled'];
  autoNerEnabled?: IPipelinePolicyEntity['autoNerEnabled'];
  harnessEnabled?: IPipelinePolicyEntity['harnessEnabled'];
  dnaStyleEnabled?: IPipelinePolicyEntity['dnaStyleEnabled'];

  createdAt?: IPipelinePolicyEntity['createdAt'];
  updatedAt?: IPipelinePolicyEntity['updatedAt'];
  createdBy?: IPipelinePolicyEntity['createdBy'];
  updatedBy?: IPipelinePolicyEntity['updatedBy'];
}

export class PipelinePolicyFactory {
  /**
   * Build a new pipeline-policy row. `scope` defaults to TENANT (the
   * tenant-default tier). The toggle columns default to `null` — a fresh row
   * overrides NOTHING until a knob is set, so the cascade keeps inheriting from
   * the next tier up. Callers create overrides by passing the scope + scopeId
   * (department/user id) and only the toggles they intend to pin.
   */
  static CreatePipelinePolicy(props: CreatePipelinePolicyProps): PipelinePolicyEntity {
    const id = generateId();
    const now = new Date();

    return new PipelinePolicyEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      resourceStatus: props.resourceStatus,
      resourceStatusUpdatedAt: props.resourceStatusUpdatedAt,
      resourceStatusUpdatedBy: props.resourceStatusUpdatedBy,

      scope: props.scope ?? Enums.PipelinePolicyScope.TENANT,
      scopeId: props.scopeId ?? null,
      autoSummaryEnabled: props.autoSummaryEnabled ?? null,
      autoNerEnabled: props.autoNerEnabled ?? null,
      harnessEnabled: props.harnessEnabled ?? null,
      dnaStyleEnabled: props.dnaStyleEnabled ?? null,

      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
