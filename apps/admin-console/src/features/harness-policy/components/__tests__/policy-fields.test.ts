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
import { buildSparsePatch, fieldDisplayValue, POLICY_FIELD_GROUPS, POLICY_FIELDS, TENANT_LOCKED_POLICY_KEYS } from '../policy-fields';

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

// TASK-1001 wave 5 — the clinician gate's abandon bound ("close after N SLA breaches"). Nullable:
// an empty input clears it back to "no opinion" (inherit SYSTEM), never to 0.
describe('gate abandon bound (gateMaxEscalations)', () => {
  const base = { gateMaxEscalations: 1 } as unknown as Parameters<typeof buildSparsePatch>[0];

  it('renders in the Clinician gate group after the two timers', () => {
    const group = POLICY_FIELD_GROUPS.find((candidate) => candidate.title === 'Clinician gate');
    expect(group?.fields.map((field) => field.key)).toEqual(['gateSlaSeconds', 'gateEscalationSeconds', 'gateMaxEscalations']);
  });

  it('an emptied input sends null (inherit), a number sends the number', () => {
    expect(buildSparsePatch(base, { gateMaxEscalations: '' })).toEqual({ gateMaxEscalations: null });
    expect(buildSparsePatch(base, { gateMaxEscalations: '2' })).toEqual({ gateMaxEscalations: 2 });
  });

  it('shows an unset bound as a dash', () => {
    const field = POLICY_FIELDS.find((candidate) => candidate.key === 'gateMaxEscalations')!;
    expect(fieldDisplayValue(field, { gateMaxEscalations: null } as never)).toBe('—');
  });
});
