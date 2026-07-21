import { EntityId, TenantPlan } from '@arcaai/domains';
import { EntitlementLimitKey } from './enforcement';

/**
 * Per-capability record of what a downgrade soft-disabled (Q10). `ids` are the
 * NEWEST-created overflow rows flipped to `resourceStatus = DISABLED` (a
 * reversible status change — NEVER a delete). Empty when the tenant was within
 * the new limit for that capability.
 */
export interface DowngradeDisabledGroup {
  capability: EntitlementLimitKey;
  resourceType: string;
  limit: number | null;
  disabledCount: number;
  ids: EntityId[];
}

/**
 * Outcome of an explicit downgrade action. The plan change ALWAYS applies; the
 * soft-disable only runs when the enforcement kill-switch is ON (Q9), so a
 * downgrade with enforcement OFF simply relabels the plan (block-new begins the
 * moment enforcement is later enabled, grandfathering everything in between).
 */
export interface DowngradeReport {
  tenantId: EntityId;
  fromPlan: TenantPlan | null;
  toPlan: TenantPlan;
  enforcementEnabled: boolean;
  disabled: DowngradeDisabledGroup[];
  totalDisabled: number;
}

/** Outcome of one trial-expiry sweep. */
export interface TrialExpiryReport {
  examined: number;
  downgraded: number;
  tenantIds: EntityId[];
}

/**
 * Trial-expiry (Q4) + explicit downgrade (Q10) lifecycle actions.
 *
 * Kept OUT of the request-scoped `EntitlementsService`: these run cross-tenant
 * (a scheduled sweep, or a super-admin acting on another tenant) and therefore
 * use the UNSCOPED base client with an explicit `tenantId`, re-establishing a
 * per-tenant CLS scope so each mutation's `SysEvent`/audit is attributed to the
 * TARGET tenant — the same escape hatch the BullMQ processors use.
 */
export interface IEntitlementsLifecycleService {
  /**
   * Trial-expiry sweep (Q4): downgrade every `plan = TRIAL` tenant whose
   * `trialEndsAt <= now` to `STARTER`. PLAN-ONLY — `resourceStatus` is left
   * untouched (proposal §4). The reserved system tenant is always skipped
   * (`assertNotSystemTenant`). Idempotent: a tenant already off TRIAL is not
   * re-examined. Independent of the enforcement kill-switch (a plan relabel is
   * always safe; enforcement gates only the block/soft-disable behavior).
   */
  expireTrials(now?: Date): Promise<TrialExpiryReport>;

  /**
   * Explicit downgrade (Q10): set `plan = newPlan`, then — WHEN the enforcement
   * kill-switch is ON — soft-disable the NEWEST-created overflow rows for every
   * quantity capability whose new limit is below the current count. The
   * disable is a reversible `resourceStatus = DISABLED` flip; existing rows
   * within the new limit are grandfathered (block-new-only). The system tenant
   * is rejected.
   */
  triggerDowngrade(tenantId: EntityId, newPlan: TenantPlan): Promise<DowngradeReport>;

  /** Current scheduled trial-expiry config (enabled + cron), read live. */
  getConfig(): { enabled: boolean; cron: string };
}

export const IEntitlementsLifecycleService = Symbol('IEntitlementsLifecycleService');
