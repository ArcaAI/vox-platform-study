/**
 * the safety provider/model controls are RETIRED.
 *
 * Both columns were dropped from `HarnessPolicy` (no runtime reader; the guardrail
 * selection lives in the `guardrail.safety` AiTaskDefault, resolved by apps/guardrail
 * tenant-first). The console half matters on its own: the GLOBAL tab passes no
 * `lockedKeys`, so a super admin could type into these two inputs and
 * `buildSparsePatch` would send them. Against a dropped column that is a 500, so the
 * controls go with the columns rather than being locked like the tenant tab's.
 */

import { describe, expect, it } from 'vitest';
import { POLICY_FIELD_GROUPS, POLICY_FIELDS, TENANT_LOCKED_POLICY_KEYS } from '../policy-fields';

const RETIRED_KEYS = ['safetyProvider', 'safetyModel'];

describe('policy field descriptors after the  Phase 4 drop', () => {
  it.each(RETIRED_KEYS)('does not render a control for %s', (key) => {
    expect(POLICY_FIELDS.map((field) => field.key)).not.toContain(key);
  });

  it.each(RETIRED_KEYS)('does not carry %s in the tenant lock list', (key) => {
    expect(TENANT_LOCKED_POLICY_KEYS as readonly string[]).not.toContain(key);
  });

  it('keeps the Safety & PHI group, reduced to the three surviving toggles', () => {
    const group = POLICY_FIELD_GROUPS.find((candidate) => candidate.title === 'Safety & PHI');
    expect(group?.fields.map((field) => field.key)).toEqual(['safetyEnabled', 'phiEnabled', 'phiFailClosed']);
  });

  it('still locks the toggles and the TEXT routing keys for tenant admins', () => {
    expect(TENANT_LOCKED_POLICY_KEYS).toEqual(['safetyEnabled', 'phiEnabled', 'phiFailClosed', 'textProvider', 'textModel']);
  });
});
