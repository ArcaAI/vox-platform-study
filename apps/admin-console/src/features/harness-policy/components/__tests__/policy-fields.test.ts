/**
 * The safety provider/model controls are RETIRED, and — since TASK-881 — so are the
 * text-generation provider/model controls.
 *
 * All four columns were dropped from `HarnessPolicy` (the guardrail selection lives in
 * the SYSTEM `guardrail.safety` routing election, resolved by apps/guardrail; text
 * selection is the tenant's assigned TEXT_GENERATION agent). The console half matters
 * on its own: the GLOBAL tab passes no `lockedKeys`, so a super admin could type into
 * these inputs and `buildSparsePatch` would send them. Against a dropped column that
 * is a 400 from the strict validation pipe, so the controls go with the columns rather
 * than being locked like the tenant tab's.
 */

import { describe, expect, it } from 'vitest';
import { POLICY_FIELD_GROUPS, POLICY_FIELDS, TENANT_LOCKED_POLICY_KEYS } from '../policy-fields';

const RETIRED_KEYS = ['safetyProvider', 'safetyModel', 'textProvider', 'textModel'];

describe('policy field descriptors after the column drops', () => {
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

  it('still locks the three toggles for tenant admins — and nothing else', () => {
    expect(TENANT_LOCKED_POLICY_KEYS).toEqual(['safetyEnabled', 'phiEnabled', 'phiFailClosed']);
  });

  it('keeps the Generation group, reduced to the regen budget', () => {
    const group = POLICY_FIELD_GROUPS.find((candidate) => candidate.title === 'Generation');
    expect(group?.fields.map((field) => field.key)).toEqual(['maxRegen']);
  });
});
