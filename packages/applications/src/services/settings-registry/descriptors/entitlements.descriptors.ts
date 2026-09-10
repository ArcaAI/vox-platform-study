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
  /*
   * `entitlements.featureDnaReports`, `.featureVoiceEnrollment` and
   * `.featureMonitoringAccess` were generated here from a three-row table.
   * TASK-872 removed the descriptors; TASK-883 removed the FLAGS THEMSELVES —
   * `PlanEntitlement` and `TenantEntitlement` no longer carry those columns,
   * because they resolved into the capability snapshot, were rendered by three
   * console badges, and were consulted by no gate.
   *
   * Two separate findings, in that order. The descriptors were dead first: the
   * `entitlement` tier has no resolution lane (`EffectiveSettingsService`
   * throws for it) and no write lane, so they could only ever appear in the
   * catalog listing as controls that answer nothing. Cataloguing a plan ceiling
   * as a setting also blurs the rule that entitlements BOUND what a tenant may
   * set and never supply a value.
   */
  /*
   * Declared on its own, not folded into the retired three's `.map`, because
   * ONE field differed and that field is the whole point.
   *
   * `failMode: 'closed'`. The three retired feature descriptors were
   * `open-to-default`, which is right for a display flag: an unresolved value
   * degrades to "show it". This one decides whether the platform SPENDS ITS OWN
   * MONEY on a tenant's cloud calls, so an unresolved value must raise rather
   * than substitute a permissive default — the same fail-closed rule the
   * settings framework applies to provider/model SELECTION.
   *
   * `default: false` is the seeded plan value on all four tiers ; grants
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
   * `entitlements.featureGuardrailModelSelection` was declared here (D2,
   * tighten-only) as a CATALOGUED-BUT-NOT-ENFORCED ceiling. TASK-872 removed
   * the descriptor.
   *
   * Nothing read it. Enforcement of D2's floor was the platform-approved-list
   * half in `AiTaskDefaultService.upsertRow` (a `guardrail.*` binding must name
   * a SYSTEM-tenant `AiModel` row), which does not consult this key; wiring the
   * entitlement half needs a `PlanEntitlement` / `TenantEntitlement` COLUMN
   * that does not exist. A descriptor for a column that has not been added is a
   * promise the registry cannot keep — the intent belongs in the ticket that
   * adds the column, not in the live catalog.
   */
];
