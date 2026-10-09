import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import {
  GUARDRAIL_CHECK_DEFAULTS,
  GUARDRAIL_POLICY_CATALOGUE,
  GuardrailPolicySelectionError,
  PLATFORM_DEFAULT_GUARDRAIL_POLICIES,
  assertBothDirectionsCovered,
  assertSelectionTightensOnly,
  hasEnabledPolicy,
  normalizeSelection,
  resolveAvailability,
} from '../policy-catalogue';

/**
 * The cross-language contract. Both this catalogue and
 * `apps/guardrail/src/guardrail/core/availability.py` are pinned against the
 * SAME file, so a policy added on one side and not the other turns one of the
 * two suites red. Same mechanism as `resolved-asr-spec.fixture.json`.
 */
const CONTRACT = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../../apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json', import.meta.url)),
    'utf8',
  ),
) as {
  policies: {
    id: string;
    directions: string[];
    threshold?: { field: string; floorDirection: string; minimum: number; maximum: number };
    allowedActions: string[];
    platformDefaultAction: string;
    locked: boolean;
    defaultEnabled: boolean;
    inboundRegions?: string[];
    platformDefaultDataRegionAction?: string;
  }[];
};

/** TASK-1050: the per-check defaults the `@arcaai/types` policy normalizer and field guard are parameterised with. */
const POLICY_FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../../../tests/contracts/guardrail-policy.fixture.json', import.meta.url)), 'utf8'),
) as { defaults: Record<string, unknown> };

describe('guardrail policy catalogue — the cross-language contract', () => {
  it('declares exactly the ids the contract fixture names, in order', () => {
    expect(GUARDRAIL_POLICY_CATALOGUE.map((p) => p.id)).toEqual(CONTRACT.policies.map((p) => p.id));
  });

  it('agrees with the contract on directions and on every threshold spec', () => {
    for (const expected of CONTRACT.policies) {
      const actual = GUARDRAIL_POLICY_CATALOGUE.find((p) => p.id === expected.id)!;
      expect(actual.directions).toEqual(expected.directions);
      expect(actual.threshold ?? null).toEqual(expected.threshold ?? null);
    }
  });

  // Guardrails check the request AND the response (owner decisions OD-1..OD-5): every classifier
  // check ships ON except `response_refusal` — a refusal is not unsafe content. TASK-1050: the locked
  // medical check ships ON, the four judges ship OFF (OD-6). The seed mirrors this.
  const CALIBRATED_OFF: readonly string[] = ['response_refusal', 'injection_judge', 'unsafe_content_judge', 'clinical_safety_judge', 'leakage_judge'];

  it('seeds the platform default as the contract declares: classifiers and medical ON, response_refusal and the judges OFF', () => {
    for (const policy of GUARDRAIL_POLICY_CATALOGUE) {
      expect(PLATFORM_DEFAULT_GUARDRAIL_POLICIES[policy.id]?.enabled, policy.id).toBe(!CALIBRATED_OFF.includes(policy.id));
      expect(policy.defaultEnabled, policy.id).toBe(!CALIBRATED_OFF.includes(policy.id));
    }
    expect(Object.keys(PLATFORM_DEFAULT_GUARDRAIL_POLICIES).sort()).toEqual(GUARDRAIL_POLICY_CATALOGUE.map((p) => p.id).sort());
  });

  it('agrees with the contract on violation handling (TASK-1050)', () => {
    for (const expected of CONTRACT.policies) {
      const actual = GUARDRAIL_POLICY_CATALOGUE.find((p) => p.id === expected.id)!;
      expect(actual.allowedActions, expected.id).toEqual(expected.allowedActions);
      expect(actual.platformDefaultAction, expected.id).toBe(expected.platformDefaultAction);
      expect(actual.locked, expected.id).toBe(expected.locked);
      expect(actual.defaultEnabled, expected.id).toBe(expected.defaultEnabled);
      expect(actual.inboundRegions ?? null, expected.id).toEqual(expected.inboundRegions ?? null);
      expect(actual.platformDefaultDataRegionAction ?? null, expected.id).toEqual(expected.platformDefaultDataRegionAction ?? null);
      expect(actual.allowedActions, expected.id).toContain(actual.platformDefaultAction);
    }
  });

  it('classifier checks default to block, except the safety/toxicity classifiers (inbound owner 2026-10-09, outbound 2026-10-08), which warn', () => {
    const blocking = ['jailbreak_detection', 'response_refusal', 'pii_leak', 'containment_echo'];
    for (const id of blocking) expect(GUARDRAIL_POLICY_CATALOGUE.find((p) => p.id === id)?.platformDefaultAction, id).toBe('block');
    for (const id of ['prompt_safety', 'prompt_toxicity', 'response_safety', 'response_toxicity']) expect(GUARDRAIL_POLICY_CATALOGUE.find((p) => p.id === id)?.platformDefaultAction, id).toBe('warn');
  });

  it('locks medical validation at block, and the judges default to the README actions', () => {
    const byId = (id: string) => GUARDRAIL_POLICY_CATALOGUE.find((p) => p.id === id)!;
    expect(byId('medical_validation')).toMatchObject({ locked: true, platformDefaultAction: 'block', allowedActions: ['block'], defaultEnabled: true });
    expect(byId('injection_judge').platformDefaultAction).toBe('ignore');
    expect(byId('unsafe_content_judge').platformDefaultAction).toBe('warn');
    expect(byId('clinical_safety_judge').platformDefaultAction).toBe('warn');
    expect(byId('leakage_judge').platformDefaultAction).toBe('block');
    // README §10.2 A3: the inbound judges screen DATA regions only.
    expect(byId('injection_judge').inboundRegions).toEqual(['data']);
    expect(byId('unsafe_content_judge').inboundRegions).toEqual(['data']);
  });

  it('exports the per-check defaults the @arcaai/types policy functions take, equal to the policy fixture', () => {
    expect(GUARDRAIL_CHECK_DEFAULTS).toEqual(POLICY_FIXTURE.defaults);
    expect(Object.keys(GUARDRAIL_CHECK_DEFAULTS)).toEqual(GUARDRAIL_POLICY_CATALOGUE.map((p) => p.id));
  });

  it('carries the pii_leak floor verbatim from core/policy.py::_SPECS', () => {
    // `piiLeakMinScore` = 0.5 there. Transcribed, not invented — seeding it
    // changes no behaviour, and a floor with nothing to compare to cannot
    // refuse anything.
    expect(PLATFORM_DEFAULT_GUARDRAIL_POLICIES.pii_leak?.minScore).toBe(0.5);
  });
});

describe('resolveAvailability — tenant → SYSTEM, widening on ABSENCE ONLY', () => {
  const SYSTEM_SET = { prompt_safety: { enabled: true }, pii_leak: { enabled: true, minScore: 0.5 } };

  it('serves the SYSTEM set to a tenant with no row', () => {
    const resolved = resolveAvailability(null, SYSTEM_SET, 'tenant-a');
    expect(resolved.policies).toEqual(SYSTEM_SET);
    expect(resolved.sourceTenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('serves the tenant set when the tenant selected something', () => {
    const tenantSet = { prompt_safety: { enabled: true } };
    const resolved = resolveAvailability(tenantSet, SYSTEM_SET, 'tenant-a');
    expect(resolved.policies).toEqual(tenantSet);
    expect(resolved.sourceTenantId).toBe('tenant-a');
  });

  it('an EMPTY selection is not an off switch — it inherits SYSTEM', () => {
    expect(resolveAvailability({}, SYSTEM_SET, 'tenant-a').sourceTenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('an ALL-DISABLED selection is not an off switch either', () => {
    const allOff = { prompt_safety: { enabled: false }, pii_leak: { enabled: false } };
    const resolved = resolveAvailability(allOff, SYSTEM_SET, 'tenant-a');
    expect(resolved.policies).toEqual(SYSTEM_SET);
    expect(resolved.sourceTenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('a selection that enables ONLY the locked medical check is no opinion (TASK-1050)', () => {
    // Medical validation is always on; a row naming only it expressed nothing about the screens.
    const resolved = resolveAvailability({ medical_validation: { enabled: true } }, SYSTEM_SET, 'tenant-a');
    expect(resolved.sourceTenantId).toBe(SYSTEM_TENANT_ID);
    expect(hasEnabledPolicy({ medical_validation: { enabled: true } })).toBe(false);
  });

  it('falls back to the built-in platform default when even SYSTEM has no set', () => {
    // A cold database (unseeded SYSTEM row) must still screen. There is no
    // configuration state in which the gate is empty.
    const resolved = resolveAvailability(null, null, 'tenant-a');
    expect(resolved.policies).toEqual(PLATFORM_DEFAULT_GUARDRAIL_POLICIES);
    expect(hasEnabledPolicy(resolved.policies)).toBe(true);
  });

  it('never lets a SYSTEM-tenant request read a customer set', () => {
    const resolved = resolveAvailability({ prompt_safety: { enabled: true } }, SYSTEM_SET, SYSTEM_TENANT_ID);
    expect(resolved.sourceTenantId).toBe(SYSTEM_TENANT_ID);
    expect(resolved.policies).toEqual(SYSTEM_SET);
  });
});

describe('normalizeSelection — the catalogue is the only legal vocabulary', () => {
  it('accepts a well-formed selection', () => {
    expect(normalizeSelection({ pii_leak: { enabled: true, minScore: 0.2 } })).toEqual({ pii_leak: { enabled: true, minScore: 0.2 } });
  });

  it('refuses an unknown policy id rather than dropping it', () => {
    expect(() => normalizeSelection({ not_a_check: { enabled: true } })).toThrow(GuardrailPolicySelectionError);
  });

  it('refuses a missing `enabled` flag', () => {
    expect(() => normalizeSelection({ prompt_safety: {} })).toThrow(/requires a boolean 'enabled'/);
  });

  it('refuses a threshold on a policy that has none', () => {
    expect(() => normalizeSelection({ prompt_safety: { enabled: true, minScore: 0.1 } })).toThrow(/has no strictness to set/);
  });

  it('refuses an out-of-range threshold', () => {
    expect(() => normalizeSelection({ pii_leak: { enabled: true, minScore: 1.5 } })).toThrow(/within \[0, 1\]/);
  });

  it('refuses a non-object payload', () => {
    expect(() => normalizeSelection([])).toThrow(GuardrailPolicySelectionError);
  });

  it('refuses switching off a catalogue-locked check (TASK-1050, OD-9)', () => {
    expect(() => normalizeSelection({ medical_validation: { enabled: false } })).toThrow(/locked/);
    expect(normalizeSelection({ medical_validation: { enabled: true } })).toEqual({ medical_validation: { enabled: true } });
  });

  it('accepts the new judge ids', () => {
    expect(normalizeSelection({ leakage_judge: { enabled: true } })).toEqual({ leakage_judge: { enabled: true } });
  });
});

describe('assertSelectionTightensOnly — refuse, never clamp', () => {
  const SYSTEM_SET = { pii_leak: { enabled: true, minScore: 0.5 } };

  it('allows a STRICTER threshold (lower minScore inspects more spans)', () => {
    expect(() => assertSelectionTightensOnly({ pii_leak: { enabled: true, minScore: 0.2 } }, SYSTEM_SET)).not.toThrow();
  });

  it('allows the platform value unchanged', () => {
    expect(() => assertSelectionTightensOnly({ pii_leak: { enabled: true, minScore: 0.5 } }, SYSTEM_SET)).not.toThrow();
  });

  it('REFUSES a looser threshold with a 403 naming both values', () => {
    let caught: unknown;
    try {
      assertSelectionTightensOnly({ pii_leak: { enabled: true, minScore: 0.9 } }, SYSTEM_SET);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect((caught as Error).message).toMatch(/may only be tightened/);
    expect((caught as Error).message).toContain('0.9');
    expect((caught as Error).message).toContain('0.5');
  });

  it('does NOT floor-check the enabled set — narrowing is the surface’s purpose', () => {
    // Only a platform admin reaches this write lane; owner decision #3 is that
    // they may narrow or widen which policies apply per tenant.
    expect(() => assertSelectionTightensOnly({ pii_leak: { enabled: false } }, SYSTEM_SET)).not.toThrow();
  });
});

describe('assertBothDirectionsCovered — a direction may never be switched off', () => {
  it('accepts an empty selection (it inherits the SYSTEM set, which covers both)', () => {
    expect(() => assertBothDirectionsCovered({})).not.toThrow();
  });

  it('accepts the single both-directions policy as the minimal legal narrowing', () => {
    expect(() => assertBothDirectionsCovered({ jailbreak_detection: { enabled: true } })).not.toThrow();
  });

  it('refuses an outbound-only selection — every request would be ungated', () => {
    expect(() => assertBothDirectionsCovered({ response_safety: { enabled: true } })).toThrow(/inbound would have no check/);
  });

  it('refuses an inbound-only selection', () => {
    expect(() => assertBothDirectionsCovered({ prompt_safety: { enabled: true } })).toThrow(/outbound would have no check/);
  });

  it('a catalogue-locked check never counts as covering a direction (it runs regardless)', () => {
    expect(() => assertBothDirectionsCovered({ medical_validation: { enabled: true }, response_safety: { enabled: true } })).toThrow(
      /inbound would have no check/,
    );
  });

  it('accepts one policy per direction', () => {
    expect(() => assertBothDirectionsCovered({ prompt_safety: { enabled: true }, response_safety: { enabled: true } })).not.toThrow();
  });
});
