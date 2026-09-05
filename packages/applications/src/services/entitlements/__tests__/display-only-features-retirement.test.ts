// TASK-883 — the three DISPLAY-ONLY entitlement flags are retired.
//
// `featureDnaReports` / `featureVoiceEnrollment` / `featureMonitoringAccess`
// resolved into `capabilities.features.{dnaReports,voiceEnrollment,
// monitoringAccess}` and were read by three console badges and nothing else:
// no `isFeatureEnabled` call site, no service branch, no gate. Their
// `TenantEntitlement` override twins go with them — an override of a base that
// no longer exists is not a smaller change, it is an incoherent one.
//
// The enforcing siblings STAY and are pinned here, because "remove the
// display-only booleans" is one careless sed away from removing a flag that
// gates platform spend:
//   platformDefaultCredential — `AiProviderConnectionService` (SYSTEM-tier credential)
//   agenticLoop               — `LoopContextSignalService` (harness loop signals)
//   paletteStt                — `WorkflowDefinitionService.publish()`
import { describe, expect, it } from 'vitest';
import { TenantPlan } from '@arcaai/domains';
import { resolveEntitlements, UNGATED_ENTITLEMENTS } from '../resolve-entitlements';
import { PLAN_ENTITLEMENT_DEFAULTS } from '../entitlements.constants';

const RETIRED_CAPABILITIES = ['dnaReports', 'voiceEnrollment', 'monitoringAccess'];
const RETIRED_COLUMNS = ['featureDnaReports', 'featureVoiceEnrollment', 'featureMonitoringAccess'];
const SURVIVING_CAPABILITIES = ['platformDefaultCredential', 'paletteStt', 'agenticLoop'];

describe('TASK-883 — display-only entitlement features', () => {
  it('resolves no retired capability for a real plan', () => {
    const resolved = resolveEntitlements(TenantPlan.PRO, null, null);
    expect(Object.keys(resolved.features).sort()).toEqual([...SURVIVING_CAPABILITIES].sort());
  });

  it('resolves no retired capability for a null-plan (ungated) tenant', () => {
    for (const name of RETIRED_CAPABILITIES) {
      expect(UNGATED_ENTITLEMENTS.features, name).not.toHaveProperty(name);
    }
    expect(Object.keys(UNGATED_ENTITLEMENTS.features).sort()).toEqual([...SURVIVING_CAPABILITIES].sort());
  });

  it('carries no retired column in the seeded plan matrix', () => {
    for (const [plan, values] of Object.entries(PLAN_ENTITLEMENT_DEFAULTS)) {
      for (const column of RETIRED_COLUMNS) {
        expect(values, `${plan}.${column}`).not.toHaveProperty(column);
      }
    }
  });

  it('ignores a retired column supplied on a plan row or a tenant override', () => {
    // A stale caller (an un-regenerated SDK, a hand-rolled PATCH) must not be
    // able to reintroduce the capability through the resolver.
    const resolved = resolveEntitlements(
      TenantPlan.PRO,
      { featureDnaReports: true } as never,
      { featureVoiceEnrollment: true, featureMonitoringAccess: true } as never,
    );
    for (const name of RETIRED_CAPABILITIES) {
      expect(resolved.features, name).not.toHaveProperty(name);
    }
  });

  it('keeps every ENFORCING feature resolving', () => {
    const resolved = resolveEntitlements(TenantPlan.STARTER, null, null);
    expect(resolved.features.platformDefaultCredential).toBe(false);
    expect(resolved.features.paletteStt).toBe(true);
    expect(resolved.features.agenticLoop).toBe(false);
  });
});
