/**
 * TASK-1050 W1 — tenant guardrail policy v2: the legacy → v2 normalizer and the field-level guard
 * (README §9.3, §11.1), driven by `tests/contracts/guardrail-policy.fixture.json`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  forbiddenGuardrailPolicyChanges,
  guardrailPolicyChangedFields,
  guardrailPolicyEditableFields,
  isTenantGuardrailPolicyV2,
  normalizeTenantGuardrailPolicy,
  type GuardrailCheckDefaults,
  type GuardrailPolicyCallerClass,
  type GuardrailPolicyKeyCatalogue,
} from '../guardrail-policy.js';
import { GUARDRAIL_CHECK_IDS } from '../guardrail-vocabulary.js';

const fixture = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../tests/contracts/guardrail-policy.fixture.json'), 'utf8')) as {
  defaults: GuardrailCheckDefaults;
  normalize: Array<{ name: string; input: unknown; expected: unknown }>;
  fieldGuard: Array<{ name: string; caller: GuardrailPolicyCallerClass; before: unknown; after: unknown; forbidden: string[] }>;
};
const availability = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../apps/guardrail/src/guardrail/tests/contracts/availability-catalogue.json'), 'utf8'),
) as {
  policies: Array<{ id: string; defaultEnabled: boolean; platformDefaultAction: string; locked: boolean; allowedActions: string[] }>;
};
const defaults = fixture.defaults;

describe('fixture defaults are the availability catalogue, verbatim', () => {
  it('one entry per check id, derived from the catalogue', () => {
    expect(Object.keys(defaults)).toEqual([...GUARDRAIL_CHECK_IDS]);
    for (const policy of availability.policies) {
      expect(defaults[policy.id as keyof GuardrailCheckDefaults], policy.id).toEqual({
        enabled: policy.defaultEnabled,
        action: policy.platformDefaultAction,
        locked: policy.locked,
        allowedActions: policy.allowedActions,
      });
    }
  });
});

describe('normalizeTenantGuardrailPolicy — legacy flat shape and v2, one output shape', () => {
  it.each(fixture.normalize.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(normalizeTenantGuardrailPolicy(entry.input, defaults)).toEqual(entry.expected);
  });

  it('is pure: the input is never mutated and the output is a fresh object', () => {
    const input = { prompt_safety: { enabled: false } };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = normalizeTenantGuardrailPolicy(input, defaults);
    expect(input).toEqual(snapshot);
    expect(out.checks.prompt_safety).not.toBe(input.prompt_safety);
  });

  it('is idempotent: normalising a v2 output changes nothing', () => {
    for (const entry of fixture.normalize) {
      const once = normalizeTenantGuardrailPolicy(entry.input, defaults);
      expect(normalizeTenantGuardrailPolicy(once, defaults), entry.name).toEqual(once);
    }
  });

  it('tells v2 from the legacy flat shape structurally', () => {
    expect(isTenantGuardrailPolicyV2({ checks: {} })).toBe(true);
    expect(isTenantGuardrailPolicyV2({ directions: { inbound: { enabled: true } } })).toBe(true);
    expect(isTenantGuardrailPolicyV2({ prompt_safety: { enabled: true } })).toBe(false);
    expect(isTenantGuardrailPolicyV2(null)).toBe(false);
    expect(isTenantGuardrailPolicyV2([])).toBe(false);
  });
});

describe('field-level guard — a tenant admin changes only `enabled` flags', () => {
  it.each(fixture.fieldGuard.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(forbiddenGuardrailPolicyChanges(entry.caller, entry.before, entry.after, defaults)).toEqual(entry.forbidden);
  });

  it('a tenant admin may edit the two direction switches and the enabled flag of every unlocked check', () => {
    const before = { checks: { leakage_judge: { enabled: true, action: 'block', locked: true } } };
    const fields = guardrailPolicyEditableFields('tenant_admin', before, defaults);
    const expectedChecks = GUARDRAIL_CHECK_IDS.filter((id) => id !== 'medical_validation' && id !== 'leakage_judge').map(
      (id) => `checks.${id}.enabled`,
    );
    expect(fields).toEqual(['directions.inbound.enabled', 'directions.outbound.enabled', ...expectedChecks]);
    expect(fields.some((field) => field.endsWith('.action'))).toBe(false);
  });

  it('a platform admin may edit every field of every check except the catalogue-locked one', () => {
    const fields = guardrailPolicyEditableFields('platform_admin', null, defaults);
    expect(fields).toContain('checks.pii_leak.minScore');
    expect(fields).toContain('checks.prompt_safety.action');
    expect(fields).toContain('checks.prompt_safety.locked');
    expect(fields).toContain('checks.jailbreak_detection.dataRegionAction');
    expect(fields.filter((field) => field.startsWith('checks.medical_validation.'))).toEqual([]);
    expect(fields.some((field) => field.endsWith('.setBy'))).toBe(false);
    expect(fields).toHaveLength(2 + (GUARDRAIL_CHECK_IDS.length - 1) * 5);
  });

  it('a platform round-trip that restates the catalogue-locked check unchanged is not a change (e2e S3)', () => {
    const medical = { enabled: true, action: 'block', locked: true };
    expect(forbiddenGuardrailPolicyChanges('platform_admin', { checks: {} }, { checks: { medical_validation: medical } }, defaults)).toEqual([]);
    // Moving it is still refused, whoever asks.
    expect(
      forbiddenGuardrailPolicyChanges('platform_admin', { checks: {} }, { checks: { medical_validation: { ...medical, enabled: false } } }, defaults),
    ).toEqual(['checks.medical_validation.enabled']);
    expect(
      forbiddenGuardrailPolicyChanges('platform_admin', { checks: {} }, { checks: { medical_validation: { ...medical, locked: false } } }, defaults),
    ).toEqual(['checks.medical_validation.locked']);
  });

  it('changed fields compare the EFFECTIVE value: an absent entry equals its platform default', () => {
    expect(guardrailPolicyChangedFields(null, { checks: { prompt_safety: { enabled: true, action: 'block' } } }, defaults)).toEqual([]);
    expect(guardrailPolicyChangedFields(null, { checks: { injection_judge: { enabled: true, action: 'ignore' } } }, defaults)).toEqual([
      'checks.injection_judge.enabled',
    ]);
  });
});

describe('platform policy-key catalogue entry type (README §11.3 A)', () => {
  it('describes one exported _SPECS key', () => {
    const catalogue: GuardrailPolicyKeyCatalogue = {
      schemaVersion: 1,
      keys: [
        {
          key: 'judgeTemperature',
          kind: 'hyperparameter',
          type: 'number',
          min: 0,
          max: 2,
          failMode: 'closed',
          taskKey: 'guardrail.validate',
          inPolicyVersion: true,
          editable: true,
        },
        {
          key: 'injectionJudgeCriteria',
          kind: 'criteria',
          type: 'string',
          min: null,
          max: null,
          failMode: 'closed',
          taskKey: 'guardrail.validate',
          inPolicyVersion: true,
          editable: true,
        },
      ],
    };
    expect(catalogue.keys.map((entry) => entry.key)).toEqual(['judgeTemperature', 'injectionJudgeCriteria']);
  });
});
