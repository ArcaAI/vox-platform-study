/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * One append-only fact: "tenant T held plan P over [effectiveFrom, effectiveTo)".
 *
 * The invoice engine's plan-fee basis. One row per plan the tenant has held;
 * `effectiveTo` null = still in force. A period with no covering row simply has
 * no plan fee (null-plan legacy tenants, D3) — the absence is meaningful, so a
 * row is never invented to fill a gap.
 *
 * POSTURE (the `AiUsageEvent` precedent — see `entitlement.prisma`):
 *   - NO soft delete: no `resourceStatus` column, the model is listed in
 *     MODELS_WITHOUT_SOFT_DELETE, and `softDelete()`/`restore()` throw on its
 *     repository. A wrong plan window is corrected by closing the row and
 *     appending a `correction`, never by deleting financial history.
 *   - NO sys-events on write: the plan change itself broadcasts on the Tenant it
 *     mutates; this is that change's financial-history side-record.
 *   - `_version` (OCC) + `_metadata` + audit fields are retained so the row
 *     round-trips through the shared BaseTenantEntity / Repository machinery.
 *
 * PHI: none — the billing plane stays PHI-free. `changeReason` is a bounded
 * enum-ish label (initial | upgrade | downgrade | correction), never free text.
 */
export interface ITenantPlanHistoryEntity extends IBaseTenantEntity {
  /** The plan in force over the window. Only real plans are recorded. */
  plan: Enums.TenantPlan;
  /** Inclusive lower bound of the window. */
  effectiveFrom: Date;
  /** Exclusive upper bound; null = still in force. */
  effectiveTo?: Date | null;
  /** The plan this row replaced — audit only; proration reads `plan` + window. */
  previousPlan?: Enums.TenantPlan | null;
  /** Bounded label: initial | upgrade | downgrade | correction. Never free text. */
  changeReason?: string | null;
}

export class TenantPlanHistoryEntity extends BaseTenantEntity {
  private _plan: ITenantPlanHistoryEntity['plan'];
  private _effectiveFrom: ITenantPlanHistoryEntity['effectiveFrom'];
  private _effectiveTo?: ITenantPlanHistoryEntity['effectiveTo'];
  private _previousPlan?: ITenantPlanHistoryEntity['previousPlan'];
  private _changeReason?: ITenantPlanHistoryEntity['changeReason'];

  constructor(init: ITenantPlanHistoryEntity) {
    super(init);
    this._plan = init.plan;
    this._effectiveFrom = init.effectiveFrom;
    this._effectiveTo = init.effectiveTo;
    this._previousPlan = init.previousPlan;
    this._changeReason = init.changeReason;
  }

  get plan(): ITenantPlanHistoryEntity['plan'] {
    return this._plan;
  }

  set plan(value: ITenantPlanHistoryEntity['plan']) {
    this.setProperty('plan', value);
  }

  get effectiveFrom(): ITenantPlanHistoryEntity['effectiveFrom'] {
    return this._effectiveFrom;
  }

  set effectiveFrom(value: ITenantPlanHistoryEntity['effectiveFrom']) {
    this.setProperty('effectiveFrom', value);
  }

  get effectiveTo(): ITenantPlanHistoryEntity['effectiveTo'] {
    return this._effectiveTo;
  }

  set effectiveTo(value: ITenantPlanHistoryEntity['effectiveTo']) {
    this.setProperty('effectiveTo', value);
  }

  get previousPlan(): ITenantPlanHistoryEntity['previousPlan'] {
    return this._previousPlan;
  }

  set previousPlan(value: ITenantPlanHistoryEntity['previousPlan']) {
    this.setProperty('previousPlan', value);
  }

  get changeReason(): ITenantPlanHistoryEntity['changeReason'] {
    return this._changeReason;
  }

  set changeReason(value: ITenantPlanHistoryEntity['changeReason']) {
    this.setProperty('changeReason', value);
  }

  /**
   * Close the currently-open window at `at`.
   *
   * The ONLY sanctioned way a row stops being in force: the plane is
   * append-only, so a plan change closes the open row here and appends a new
   * one rather than editing any window in place.
   */
  public supersedeAt(at: Date): void {
    if (this._effectiveTo) {
      throw new BusinessException('TenantPlanHistory window is already closed.');
    }
    if (at.getTime() < this._effectiveFrom.getTime()) {
      throw new BusinessException('TenantPlanHistory effectiveTo cannot precede effectiveFrom.');
    }
    this.effectiveTo = at;
  }

  public override validate(): void {
    super.validate();
    if (this._plan === undefined || this._plan === null) {
      throw new BusinessException('TenantPlanHistory plan is required.');
    }
    if (!this._effectiveFrom) {
      throw new BusinessException('TenantPlanHistory effectiveFrom is required.');
    }
    // An inverted window would make every proration over it negative.
    if (this._effectiveTo && this._effectiveTo.getTime() < this._effectiveFrom.getTime()) {
      throw new BusinessException('TenantPlanHistory effectiveTo cannot precede effectiveFrom.');
    }
  }
}
