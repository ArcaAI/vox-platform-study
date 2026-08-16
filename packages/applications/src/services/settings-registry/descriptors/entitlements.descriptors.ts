// Entitlements descriptors.
//
// The global kill-switch (data class 4) and the plan feature flags (data class 5)
// — both SUPER_ADMIN-only. Keys mirror the entitlements constants:
//   - `entitlements.enabled` (GlobalSetting under the reserved entitlements tenant)
//   - `feature*` bundle columns on PlanEntitlement / TenantEntitlement.

import { SettingDescriptor } from '../registry.types';

export const ENTITLEMENT_SETTINGS: SettingDescriptor[] = [
  {
    key: 'entitlements.enabled',
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    killSwitch: true,
    // Kill-switch — unset degrades to the code default (OFF), i.e. enforcement
    // stays a no-op. Fail-CLOSED here would mean "enforcement errors block every
    // request", the opposite of a fail-safe rollout.
    failMode: 'open-to-default',
    category: 'Platform',
    label: 'Entitlements enforcement',
    description: 'Master kill-switch for quota/feature enforcement (ships OFF; every check is a no-op until enabled).',
    default: false,
  },
  ...(
    [
      ['featureDnaReports', 'DNA reports', 'Access to DNA writing-style reports.'],
      ['featureVoiceEnrollment', 'Voice enrollment', 'Access to speaker voice enrollment.'],
      ['featureMonitoringAccess', 'Monitoring access', 'Access to the monitoring surfaces.'],
    ] as const
  ).map<SettingDescriptor>(([key, label, description]) => ({
    key: `entitlements.${key}`,
    tier: 'entitlement',
    dataType: 'boolean',
    sensitivity: 'internal',
    // Plan-level default is platform-wide; a per-tenant override is still tenant-scoped.
    maxScope: 'tenant',
    editableBy: 'PlanEntitlement',
    globalOnly: true,
    // Entitlements are a CEILING, not a cascade level: an absent
    // plan flag means "no grant", which the enforcement path already reads as
    // the descriptor default. Not a selection, so not fail-closed.
    failMode: 'open-to-default',
    category: 'Plan',
    label,
    description,
  })),
  /*
   * Declared separately from the three above, not folded into the
   * `.map`, because ONE field differs and that field is the whole point.
   *
   * `failMode: 'closed'`. The other three feature descriptors are
   * `open-to-default`, which is right for a display flag: an unresolved value
   * degrades to "show it". This one decides whether the platform SPENDS ITS OWN
   * MONEY on a tenant's cloud calls, so an unresolved value must raise rather
   * than substitute a permissive default — the same fail-closed rule the
   * settings framework applies to provider/model SELECTION.
   *
   * `default: false` is the seeded plan value on all four tiers (OD-7); grants
   * are issued per tenant through `TenantEntitlement`.
   */
  {
    key: 'entitlements.featurePlatformDefaultCredential',
    tier: 'entitlement',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'PlanEntitlement',
    globalOnly: true,
    failMode: 'closed',
    category: 'Plan',
    label: 'Platform-default provider credential',
    description:
      'Whether the tenant may consume the PLATFORM-DEFAULT (SYSTEM-tenant) provider credential when it holds no key of its own. Platform-funded spend — granted per tenant, never by plan tier.',
    default: false,
  },
  /*
   * TASK-735 Phase 0 (D2, tighten-only) — the guardrail model-selection
   * entitlement ceiling. `failMode: 'closed'` for the same reason as
   * `featurePlatformDefaultCredential` above: this decides whether a tenant
   * may pick its OWN safety-plane model rather than inheriting the SYSTEM
   * default, so an unresolved value must raise, never silently grant.
   *
   * CATALOGUED, NOT YET ENFORCED. `AiTaskDefaultService.upsertRow` enforces
   * only the platform-approved-list half of D2's floor today (a `guardrail.*`
   * binding must name a SYSTEM-tenant `AiModel` row); it does not yet gate on
   * this entitlement. Wiring it requires a `PlanEntitlement`/
   * `TenantEntitlement` column addition (`packages/database` migration +
   * `resolve-entitlements.ts`/`entitlements.constants.ts` + the
   * `plan-matrix-parity.test.ts` seed/constant pair), which is outside this
   * ticket's file scope — see the TASK-735 ticket README §7.
   */
  {
    key: 'entitlements.featureGuardrailModelSelection',
    tier: 'entitlement',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'PlanEntitlement',
    globalOnly: true,
    failMode: 'closed',
    category: 'Plan',
    label: 'Guardrail model selection',
    description:
      'Whether the tenant may select its own guardrail (safety-plane) model from the platform-approved catalog, instead of inheriting the SYSTEM default. Granted per tenant, never by plan tier. NOT YET ENFORCED — see the TASK-735 ticket README §7 for the pending DB wiring.',
    default: false,
  },
];
