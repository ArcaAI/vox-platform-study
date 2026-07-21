/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface ITenantEntity extends Omit<IBaseTaggedEntity, 'tenantId'> {
  name: string;
  key: string;
  description?: string | null;
  // Commercial plan (nullable; existing rows read null).
  plan?: Enums.TenantPlan | null;
  // Trial clock; auto-downgrade TRIAL → STARTER on expiry.
  trialEndsAt?: Date | null;
}

export class TenantEntity extends BaseTaggedEntity {
  private _name: ITenantEntity['name'];
  private _key: ITenantEntity['key'];
  private _description?: ITenantEntity['description'];
  private _plan?: ITenantEntity['plan'];
  private _trialEndsAt?: ITenantEntity['trialEndsAt'];

  constructor(init: ITenantEntity) {
    // TenantEntity is its own tenant — no separate tenantId column exists on
    // core.Tenant (the schema deliberately omits it; ITenantEntity uses
    // `Omit<IBaseTaggedEntity, 'tenantId'>`). We pass `init.id` to satisfy
    // the BaseTenantEntity contract that requires a tenantId.
    // The override of validate() below intentionally does NOT call
    // super.validate(); the tenantId === id invariant is enforced here.
    super({ ...init, tenantId: init.id });
    this._name = init.name;
    this._key = init.key;
    this._description = init.description;
    this._plan = init.plan;
    this._trialEndsAt = init.trialEndsAt;
  }

  get name(): ITenantEntity['name'] {
    return this._name;
  }

  set name(value: ITenantEntity['name']) {
    this.setProperty('name', value);
  }

  get key(): ITenantEntity['key'] {
    return this._key;
  }

  set key(value: ITenantEntity['key']) {
    this.setProperty('key', value);
  }

  get description(): ITenantEntity['description'] {
    return this._description;
  }

  set description(value: ITenantEntity['description']) {
    this.setProperty('description', value);
  }

  get plan(): ITenantEntity['plan'] {
    return this._plan;
  }

  set plan(value: ITenantEntity['plan']) {
    this.setProperty('plan', value);
  }

  get trialEndsAt(): ITenantEntity['trialEndsAt'] {
    return this._trialEndsAt;
  }

  set trialEndsAt(value: ITenantEntity['trialEndsAt']) {
    this.setProperty('trialEndsAt', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Suspends the tenant, setting its status to `SUSPENDED` — a reversible
   * operator hold distinct from the routine `DISABLED` on/off toggle. Restore
   * with the inherited `enable()` (→ ENABLED). Kept on the subclass (not
   * `BaseEntity`) because SUSPENDED is a tenant lifecycle state, not a generic
   * resource state.
   *
   * @param updatedBy - (Optional) The id of the user who performed the action.
   * @returns The current instance for method chaining.
   */
  public suspend(updatedBy?: string): this {
    this.setProperty('resourceStatus', Enums.ResourceStatusType.SUSPENDED);
    this.setProperty('resourceStatusUpdatedAt', new Date());
    if (updatedBy) {
      this.setProperty('resourceStatusUpdatedBy', updatedBy);
    }
    return this;
  }

  public override validate(): void {
    if (!this._name || this._name.trim().length === 0) {
      throw new BusinessException('Tenant name is required.');
    }
    if (this._name.length > 255) {
      throw new BusinessException('Tenant name must not exceed 255 characters.');
    }
    if (!this._key || this._key.trim().length === 0) {
      throw new BusinessException('Tenant key is required.');
    }
    if (this._key.length > 100) {
      throw new BusinessException('Tenant key must not exceed 100 characters.');
    }
    if (!/^[A-Z0-9_-]+$/i.test(this._key)) {
      throw new BusinessException('Tenant key format is invalid; expected alphanumeric, hyphen, or underscore characters only.');
    }
    if (this._description && this._description.length > 1000) {
      throw new BusinessException('Tenant description must not exceed 1000 characters.');
    }
  }
}
