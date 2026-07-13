// TASK-504 Phase 3 — entitlements descriptors.
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
    category: 'Plan',
    label,
    description,
  })),
];
