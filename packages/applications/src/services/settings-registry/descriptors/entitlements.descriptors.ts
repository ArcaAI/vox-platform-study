// Entitlements descriptors.
//
// The global kill-switch (data class 4) and the plan feature flags (data class 5)
// — both GLOBAL_ADMIN-only. Keys mirror the entitlements constants:
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
];
