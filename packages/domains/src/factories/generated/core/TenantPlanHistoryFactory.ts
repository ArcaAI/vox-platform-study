/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ITenantPlanHistoryEntity, TenantPlanHistoryEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateTenantPlanHistoryProps extends BaseEntityFactoryCreateProps {
  tenantId: ITenantPlanHistoryEntity['tenantId'];
  plan: ITenantPlanHistoryEntity['plan'];
  effectiveFrom: ITenantPlanHistoryEntity['effectiveFrom'];
  effectiveTo?: ITenantPlanHistoryEntity['effectiveTo'];
  previousPlan?: ITenantPlanHistoryEntity['previousPlan'];
  changeReason?: ITenantPlanHistoryEntity['changeReason'];

  createdAt?: ITenantPlanHistoryEntity['createdAt'];
  createdBy?: ITenantPlanHistoryEntity['createdBy'];
}

export class TenantPlanHistoryFactory {
  /**
   * Open a new plan window.
   *
   * `effectiveTo` defaults to null — "in force until superseded" — which is what
   * keeps the plane append-only: a plan change closes the PREVIOUS row via
   * `supersedeAt()` and appends this one, rather than editing a window in place.
   */
  static CreateTenantPlanHistory(props: CreateTenantPlanHistoryProps): TenantPlanHistoryEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new TenantPlanHistoryEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      plan: props.plan,
      effectiveFrom: props.effectiveFrom,
      effectiveTo: props.effectiveTo ?? null,
      previousPlan: props.previousPlan ?? null,
      changeReason: props.changeReason ?? null,
    });
  }
}
