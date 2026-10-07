/**
 * TASK-1050 W2b — the gateway half of tenant guardrail policy v2.
 *
 * The effective view MIRRORS `apps/guardrail/.../core/availability.py::_effective` (platform default →
 * SYSTEM row → tenant row, FIELD by field), because the console must show what the screener will do.
 * The stored form keeps only the fields a tier actually STATED, so a tenant's on/off toggle never pins
 * the action a platform admin set on the SYSTEM row.
 */
import { describe, expect, it } from 'vitest';
import {
  GuardrailPolicySelectionError,
} from '../policy-catalogue';
import {
  diffGuardrailPolicyAgainstEffective,
  effectiveGuardrailPolicy,
  guardrailFlatSelection,
  parsePlatformGuardrailPolicyWrite,
  parseTenantGuardrailPolicyWrite,
  toStoredGuardrailPolicyV2,
} from '../policy-v2';

const check = (view: ReturnType<typeof effectiveGuardrailPolicy>, id: string) => view.checks.find((entry) => entry.checkId === id)!;

describe('toStoredGuardrailPolicyV2 — any stored blob as stated-only v2', () => {
  it('reads the legacy flat shape as v2, keeping enabled and minScore and stating no action', () => {
    expect(toStoredGuardrailPolicyV2({ prompt_safety: { enabled: false }, pii_leak: { enabled: true, minScore: 0.3 }, not_a_check: { enabled: true } })).toEqual({
      directions: {},
      checks: { prompt_safety: { enabled: false }, pii_leak: { enabled: true, minScore: 0.3 } },
    });
  });

  it('a legacy row that enables nothing is no opinion (empty), exactly as guardrail reads it', () => {
    expect(toStoredGuardrailPolicyV2({ prompt_safety: { enabled: false }, response_safety: { enabled: false } })).toEqual({ directions: {}, checks: {} });
  });

  it('never stores an entry for a catalogue-locked check', () => {
    expect(toStoredGuardrailPolicyV2({ checks: { medical_validation: { enabled: false, action: 'ignore' } } }).checks).toEqual({});
  });

  it('keeps a v2 entry as stated, including the platform lock and setBy', () => {
    const stored = toStoredGuardrailPolicyV2({
      directions: { inbound: { enabled: false } },
      checks: { leakage_judge: { enabled: true, locked: true, setBy: 'platform_admin' }, jailbreak_detection: { action: 'warn', dataRegionAction: 'warn' } },
    });
    expect(stored).toEqual({
      directions: { inbound: { enabled: false } },
      checks: { leakage_judge: { enabled: true, locked: true, setBy: 'platform_admin' }, jailbreak_detection: { action: 'warn', dataRegionAction: 'warn' } },
    });
  });
});

describe('effectiveGuardrailPolicy — platform default → SYSTEM → tenant, field by field', () => {
  it('a tenant that only toggles `enabled` keeps the action the SYSTEM row set', () => {
    const view = effectiveGuardrailPolicy(
      { checks: { unsafe_content_judge: { enabled: true, action: 'block' } } },
      { checks: { unsafe_content_judge: { enabled: false, setBy: 'tenant_admin' } } },
    );
    expect(check(view, 'unsafe_content_judge')).toMatchObject({ enabled: false, action: 'block', inherited: false, setBy: 'tenant_admin' });
  });

  it('an absent tenant entry inherits SYSTEM, attributed to the platform', () => {
    const view = effectiveGuardrailPolicy({ checks: { leakage_judge: { enabled: true } } }, null);
    expect(check(view, 'leakage_judge')).toMatchObject({ enabled: true, action: 'block', inherited: true, setBy: 'platform_admin' });
  });

  it('the catalogue lock wins over every row: medical validation is always on, always block', () => {
    const view = effectiveGuardrailPolicy({ medical_validation: { enabled: false } }, { checks: { medical_validation: { enabled: false } } });
    expect(check(view, 'medical_validation')).toMatchObject({ enabled: true, action: 'block', locked: true, lockReason: 'catalogue', editable: false });
  });

  it('a platform lock on the tenant row or on the SYSTEM row reads as locked (reason platform)', () => {
    const onTenant = effectiveGuardrailPolicy(null, { checks: { prompt_safety: { enabled: true, locked: true } } });
    const onSystem = effectiveGuardrailPolicy({ checks: { prompt_safety: { locked: true } } }, null);
    expect(check(onTenant, 'prompt_safety')).toMatchObject({ locked: true, lockReason: 'platform' });
    expect(check(onSystem, 'prompt_safety')).toMatchObject({ locked: true, lockReason: 'platform' });
  });

  it('directions default on; a tenant direction off is monitor only and still listed', () => {
    const view = effectiveGuardrailPolicy(null, { directions: { outbound: { enabled: false } }, checks: {} });
    expect(view.directions).toEqual({ inbound: { enabled: true }, outbound: { enabled: false } });
  });

  it('the inbound classifier checks carry their data-region action (OD-12), the outbound ones none', () => {
    const view = effectiveGuardrailPolicy(null, null);
    expect(check(view, 'jailbreak_detection').dataRegionAction).toBe('ignore');
    expect(check(view, 'response_safety').dataRegionAction).toBeUndefined();
  });

  it('guardrailFlatSelection projects the effective on/off (and thresholds) for the catalogue rules', () => {
    const flat = guardrailFlatSelection(effectiveGuardrailPolicy(null, { checks: { pii_leak: { minScore: 0.2 } } }));
    expect(flat.pii_leak).toEqual({ enabled: true, minScore: 0.2 });
    expect(flat.response_refusal).toEqual({ enabled: false });
  });
});

describe('parsePlatformGuardrailPolicyWrite — what a platform admin may store (400 on anything malformed)', () => {
  it('accepts v2 and the legacy flat shape alike, rewriting both as v2', () => {
    expect(parsePlatformGuardrailPolicyWrite({ prompt_safety: { enabled: true } })).toEqual({ directions: {}, checks: { prompt_safety: { enabled: true } } });
    expect(parsePlatformGuardrailPolicyWrite({ checks: { prompt_safety: { action: 'warn', locked: true } } })).toEqual({
      directions: {},
      checks: { prompt_safety: { action: 'warn', locked: true } },
    });
  });

  it.each([
    [{ checks: { nope: { enabled: true } } }, /Unknown guardrail policy 'nope'/],
    [{ checks: { prompt_safety: { action: 'shout' } } }, /action/],
    [{ checks: { response_safety: { dataRegionAction: 'warn' } } }, /dataRegionAction/],
    [{ checks: { prompt_safety: { minScore: 0.3 } } }, /minScore/],
    [{ checks: { pii_leak: { minScore: 2 } } }, /within/],
    [{ checks: { prompt_safety: { enabled: 'yes' } } }, /enabled/],
    [{ checks: { prompt_safety: { colour: 'red' } } }, /colour/],
    [{ directions: { sideways: { enabled: true } } }, /direction/],
  ])('refuses %j', (raw, message) => {
    expect(() => parsePlatformGuardrailPolicyWrite(raw)).toThrow(GuardrailPolicySelectionError);
    expect(() => parsePlatformGuardrailPolicyWrite(raw)).toThrow(message);
  });
});

describe('parseTenantGuardrailPolicyWrite + diffGuardrailPolicyAgainstEffective — only what actually CHANGES counts', () => {
  const effective = effectiveGuardrailPolicy({ checks: { unsafe_content_judge: { enabled: true, action: 'warn' } } }, null);

  it('echoing the effective values back changes nothing (a client may send the whole view)', () => {
    const submitted = parseTenantGuardrailPolicyWrite({
      directions: { inbound: { enabled: true } },
      checks: { unsafe_content_judge: { enabled: true, action: 'warn', locked: false } },
    });
    expect(diffGuardrailPolicyAgainstEffective(submitted, effective)).toEqual([]);
  });

  it('names every field that differs from what is in force', () => {
    const submitted = parseTenantGuardrailPolicyWrite({
      directions: { outbound: { enabled: false } },
      checks: { unsafe_content_judge: { enabled: false, action: 'block' }, pii_leak: { minScore: 0.1 } },
    });
    expect(diffGuardrailPolicyAgainstEffective(submitted, effective).sort()).toEqual(
      ['checks.pii_leak.minScore', 'checks.unsafe_content_judge.action', 'checks.unsafe_content_judge.enabled', 'directions.outbound.enabled'].sort(),
    );
  });

  it('refuses an unknown check or a malformed field with 400 before any privilege decision', () => {
    expect(() => parseTenantGuardrailPolicyWrite({ checks: { nope: { enabled: true } } })).toThrow(GuardrailPolicySelectionError);
    expect(() => parseTenantGuardrailPolicyWrite({ checks: { prompt_safety: { enabled: 1 } } })).toThrow(GuardrailPolicySelectionError);
  });
});
