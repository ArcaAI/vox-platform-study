/**
 * DepartmentAgent — shared constants (TASK-546).
 */

/**
 * The tenant-tier HarnessPolicy keys a DepartmentAgent's `harnessOverrides`
 * JSONB may carry. Everything else on HarnessPolicy is
 * `GLOBAL_ADMIN_ONLY_POLICY_KEYS` (see
 * `harness-policy/harness-policy.service.ts`) and MUST NOT appear in an agent's
 * overrides — a tenant admin editing an agent may only nudge the tenant-tier
 * knobs (the 5 assurance-sensor thresholds + the 4 pipeline-shape knobs).
 *
 * Exported so TASK-550 (harness-override CONSUMPTION) reuses the exact same
 * allow-list rather than re-deriving it.
 */
export const TENANT_TIER_HARNESS_OVERRIDE_KEYS = [
  // 5 assurance-sensor thresholds
  'entityFaithfulnessThreshold',
  'coverageThreshold',
  'citationPresenceThreshold',
  'numericDoseThreshold',
  'groundednessThreshold',
  // tenant-tier pipeline-shape knobs
  'maxRegen',
  'gateSlaSeconds',
  'gateEscalationSeconds',
  'toolAllowlist',
] as const;

export type TenantTierHarnessOverrideKey = (typeof TENANT_TIER_HARNESS_OVERRIDE_KEYS)[number];

const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(TENANT_TIER_HARNESS_OVERRIDE_KEYS);

/**
 * Keys present in `overrides` that are NOT tenant-tier-allowed (i.e. would be
 * global-admin-only HarnessPolicy knobs). Empty ⇒ the override set is valid.
 */
export function disallowedHarnessOverrideKeys(overrides: Record<string, unknown>): string[] {
  return Object.keys(overrides).filter((key) => !ALLOWED_KEY_SET.has(key));
}
