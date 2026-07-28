/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TenantEntity, ITenantEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateTenantProps extends BaseEntityFactoryCreateProps {
  name: ITenantEntity['name'];
  key: ITenantEntity['key'];
  description?: ITenantEntity['description'];
  plan?: ITenantEntity['plan'];
  trialEndsAt?: ITenantEntity['trialEndsAt'];
  tags?: ITenantEntity['tags'];
  Tags?: ITenantEntity['Tags'];

  createdAt?: ITenantEntity['createdAt'];
  updatedAt?: ITenantEntity['updatedAt'];
  createdBy?: ITenantEntity['createdBy'];
  updatedBy?: ITenantEntity['updatedBy'];
}

export class TenantFactory {
  /** A trial is a 7-day PRO-entitled window. */
  private static readonly TRIAL_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

  static CreateTenant(props: CreateTenantProps): TenantEntity {
    const id = generateId();
    const now = new Date();
    const createdAt = props.createdAt || now;
    // Plan default stays `null` (factory contract). The TRIAL default
    // for customer tenants is applied one layer up in `TenantService.create`.
    const plan = props.plan ?? null;

    return new TenantEntity({
      id,

      createdAt,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      key: props.key,
      description: props.description ?? '',
      plan,
      // Stamp the trial clock when a tenant is created on the
      // TRIAL plan (unless an explicit end was supplied). The clock therefore
      // starts at creation for any TRIAL tenant; non-TRIAL tenants carry null.
      trialEndsAt: props.trialEndsAt ?? (plan === Enums.TenantPlan.TRIAL ? new Date(createdAt.getTime() + TenantFactory.TRIAL_PERIOD_MS) : null),
      tags: props.tags ?? [],
      Tags: props.Tags ?? [],
    });
  }
}
