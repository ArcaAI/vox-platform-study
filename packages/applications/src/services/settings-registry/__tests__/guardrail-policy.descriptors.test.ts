// Guardrail policy descriptors (TASK-735 Phase 4).
//
// Covers: registration/shape, the failMode split (closed for anything that
// decides a verdict, open-to-default for pure tuning), the tenant → SYSTEM →
// declared-failure-mode cascade, and the tighten-only floor (D2) — a looser
// tenant write is REJECTED (403), never clamped.

import { describe, expect, it } from 'vitest';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import {
  assertGuardrailPolicyFloor,
  GUARDRAIL_POLICY_DEFAULTS,
  GUARDRAIL_POLICY_FLOOR_DIRECTIONS,
  GUARDRAIL_POLICY_SETTINGS,
  GuardrailPolicyFloorViolation,
  GuardrailPolicyKey,
  GuardrailPolicyShortKey,
  resolveGuardrailPolicyValue,
} from '../descriptors/guardrail-policy.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

const SHORT_KEYS = Object.keys(GUARDRAIL_POLICY_DEFAULTS) as GuardrailPolicyShortKey[];
const CLOSED_KEYS: GuardrailPolicyShortKey[] = [
  'classificationThreshold',
  'piiThreshold',
  'guardianMinConfidence',
  'entailmentThreshold',
  'safetyLabels',
  'piiLabels',
  'adversarialLabels',
  'harmfulLabels',
];
const TUNING_KEYS: GuardrailPolicyShortKey[] = [
  'judgeTemperature',
  'judgeMaxTokens',
  'judgeTimeoutSeconds',
  'groundednessBatchSize',
  'groundednessMaxSegments',
];

function fullKey(short: GuardrailPolicyShortKey): GuardrailPolicyKey {
  return `guardrail.policy.${short}`;
}

describe('guardrail policy descriptors — registration and shape', () => {
  it('accounts for every key exactly once between the closed and tuning lists', () => {
    expect(new Set([...CLOSED_KEYS, ...TUNING_KEYS])).toEqual(new Set(SHORT_KEYS));
    expect(CLOSED_KEYS.length + TUNING_KEYS.length).toBe(SHORT_KEYS.length);
  });

  it('registers every key under the `guardrail.policy.` namespace in HOPE_SETTINGS_REGISTRY', () => {
    for (const short of SHORT_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.get(fullKey(short)), short).toBeDefined();
    }
  });

  it('is tier db-config, tenant-scoped, and NOT global-admin-only (tenant may tighten its own row)', () => {
    for (const d of GUARDRAIL_POLICY_SETTINGS) {
      expect(d.tier, d.key).toBe('db-config');
      expect(d.maxScope, d.key).toBe('tenant');
      expect(d.globalOnly, d.key).toBeUndefined();
      expect(d.sensitivity, d.key).toBe('internal');
    }
  });

  it('carries the code-verified default from config.py/gliner.py', () => {
    expect(GUARDRAIL_POLICY_DEFAULTS.classificationThreshold).toBe(0.4);
    expect(GUARDRAIL_POLICY_DEFAULTS.piiThreshold).toBe(0.5);
    expect(GUARDRAIL_POLICY_DEFAULTS.guardianMinConfidence).toBe(0.75);
    expect(GUARDRAIL_POLICY_DEFAULTS.entailmentThreshold).toBe(0.5);
    expect(GUARDRAIL_POLICY_DEFAULTS.judgeTemperature).toBe(0.1);
    expect(GUARDRAIL_POLICY_DEFAULTS.judgeMaxTokens).toBe(500);
    expect(GUARDRAIL_POLICY_DEFAULTS.judgeTimeoutSeconds).toBe(60);
    expect(GUARDRAIL_POLICY_DEFAULTS.groundednessBatchSize).toBe(16);
    expect(GUARDRAIL_POLICY_DEFAULTS.groundednessMaxSegments).toBe(200);
    expect(GUARDRAIL_POLICY_DEFAULTS.safetyLabels).toEqual(['safe', 'unsafe']);
    expect(GUARDRAIL_POLICY_DEFAULTS.piiLabels).toContain('date_of_birth');
    expect(GUARDRAIL_POLICY_DEFAULTS.adversarialLabels).toContain('prompt_injection');
    expect(GUARDRAIL_POLICY_DEFAULTS.harmfulLabels).toContain('hate_speech');
  });

  it('every tuning key declares descriptor.default equal to the code default; every closed key omits it', () => {
    for (const short of TUNING_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey(short)).default, short).toBe(GUARDRAIL_POLICY_DEFAULTS[short]);
    }
    for (const short of CLOSED_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey(short)).default, short).toBeUndefined();
    }
  });

  it('has a non-empty, distinct label and description for every key (operator-actionable metadata)', () => {
    const labels = new Set<string>();
    for (const d of GUARDRAIL_POLICY_SETTINGS) {
      expect(d.label?.length ?? 0, d.key).toBeGreaterThan(0);
      expect(d.description?.length ?? 0, d.key).toBeGreaterThan(20);
      labels.add(d.label as string);
    }
    expect(labels.size).toBe(GUARDRAIL_POLICY_SETTINGS.length);
  });

  it('is not a kill-switch (nothing here gates enforcement on/off)', () => {
    for (const d of GUARDRAIL_POLICY_SETTINGS) {
      expect(d.killSwitch, d.key).toBeUndefined();
    }
  });
});

describe('guardrail policy descriptors — failMode split', () => {
  it('is failMode closed for every key that decides a verdict (thresholds + taxonomies)', () => {
    for (const short of CLOSED_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey(short)).failMode, short).toBe('closed');
    }
  });

  it('is failMode open-to-default for every pure-tuning key', () => {
    for (const short of TUNING_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey(short)).failMode, short).toBe('open-to-default');
    }
  });
});

describe('resolveGuardrailPolicyValue — tenant → SYSTEM → declared failure mode', () => {
  it('prefers the tenant row over the SYSTEM row and the default', () => {
    const resolved = resolveGuardrailPolicyValue(fullKey('judgeMaxTokens'), { tenantValue: 750, systemValue: 600 });
    expect(resolved).toEqual({ key: fullKey('judgeMaxTokens'), value: 750, source: 'tenant' });
  });

  it('falls back to the SYSTEM row when no tenant row is set', () => {
    const resolved = resolveGuardrailPolicyValue(fullKey('judgeMaxTokens'), { systemValue: 600 });
    expect(resolved).toEqual({ key: fullKey('judgeMaxTokens'), value: 600, source: 'system' });
  });

  it('a `false`/`0`/empty-string-shaped SET value still counts as set (only null/undefined inherit)', () => {
    const resolved = resolveGuardrailPolicyValue(fullKey('groundednessMaxSegments'), { tenantValue: 0, systemValue: 200 });
    expect(resolved).toEqual({ key: fullKey('groundednessMaxSegments'), value: 0, source: 'tenant' });
  });

  it('open-to-default keys fall back to descriptor.default when neither tier supplies a value', () => {
    for (const short of TUNING_KEYS) {
      const resolved = resolveGuardrailPolicyValue(fullKey(short), {});
      expect(resolved, short).toEqual({ key: fullKey(short), value: GUARDRAIL_POLICY_DEFAULTS[short], source: 'code-default' });
    }
  });

  it('closed keys RAISE rather than substitute anything when neither tier supplies a value', () => {
    for (const short of CLOSED_KEYS) {
      expect(() => resolveGuardrailPolicyValue(fullKey(short), {}), short).toThrow(ArgumentInvalidException);
      expect(() => resolveGuardrailPolicyValue(fullKey(short), {}), short).toThrow(/fail-closed/i);
    }
  });

  it('closed keys still resolve normally when a tenant or SYSTEM row IS set', () => {
    expect(resolveGuardrailPolicyValue(fullKey('piiThreshold'), { tenantValue: 0.3 })).toEqual({
      key: fullKey('piiThreshold'),
      value: 0.3,
      source: 'tenant',
    });
    expect(resolveGuardrailPolicyValue(fullKey('piiThreshold'), { systemValue: 0.5 })).toEqual({
      key: fullKey('piiThreshold'),
      value: 0.5,
      source: 'system',
    });
  });

  it('throws on an unregistered key', () => {
    expect(() => resolveGuardrailPolicyValue('guardrail.policy.doesNotExist' as GuardrailPolicyKey, {})).toThrow(ArgumentInvalidException);
  });
});

describe('assertGuardrailPolicyFloor — tighten-only (D2): reject, never clamp', () => {
  describe('lower-is-stricter (classificationThreshold, piiThreshold)', () => {
    it('accepts a tenant value AT or BELOW the platform floor', () => {
      expect(() => assertGuardrailPolicyFloor(fullKey('piiThreshold'), 0.5, 0.5)).not.toThrow();
      expect(() => assertGuardrailPolicyFloor(fullKey('piiThreshold'), 0.3, 0.5)).not.toThrow();
    });

    it('rejects a tenant value ABOVE the platform floor with a 403, not a clamp', () => {
      expect(() => assertGuardrailPolicyFloor(fullKey('piiThreshold'), 0.9, 0.5)).toThrow(GuardrailPolicyFloorViolation);
      try {
        assertGuardrailPolicyFloor(fullKey('classificationThreshold'), 0.8, 0.4);
        expect.unreachable('expected a GuardrailPolicyFloorViolation');
      } catch (err) {
        expect(err).toBeInstanceOf(GuardrailPolicyFloorViolation);
        expect((err as GuardrailPolicyFloorViolation).getStatus()).toBe(403);
        expect((err as GuardrailPolicyFloorViolation).requested).toBe(0.8);
        expect((err as GuardrailPolicyFloorViolation).floor).toBe(0.4);
      }
    });
  });

  describe('higher-is-stricter (guardianMinConfidence, entailmentThreshold)', () => {
    it('accepts a tenant value AT or ABOVE the platform floor', () => {
      expect(() => assertGuardrailPolicyFloor(fullKey('guardianMinConfidence'), 0.75, 0.75)).not.toThrow();
      expect(() => assertGuardrailPolicyFloor(fullKey('entailmentThreshold'), 0.9, 0.5)).not.toThrow();
    });

    it('rejects a tenant value BELOW the platform floor', () => {
      expect(() => assertGuardrailPolicyFloor(fullKey('guardianMinConfidence'), 0.5, 0.75)).toThrow(GuardrailPolicyFloorViolation);
      expect(() => assertGuardrailPolicyFloor(fullKey('entailmentThreshold'), 0.2, 0.5)).toThrow(GuardrailPolicyFloorViolation);
    });
  });

  describe('superset-is-stricter (the four label taxonomies)', () => {
    const floor = GUARDRAIL_POLICY_DEFAULTS.harmfulLabels;

    it('accepts the floor set unchanged, and accepts a tenant-extended superset', () => {
      expect(() => assertGuardrailPolicyFloor(fullKey('harmfulLabels'), [...floor], floor)).not.toThrow();
      expect(() => assertGuardrailPolicyFloor(fullKey('harmfulLabels'), [...floor, 'self_harm'], floor)).not.toThrow();
    });

    it('rejects a tenant set that drops a platform-mandated label', () => {
      const narrowed = floor.filter((label) => label !== 'weapons');
      expect(() => assertGuardrailPolicyFloor(fullKey('harmfulLabels'), narrowed, floor)).toThrow(GuardrailPolicyFloorViolation);
    });
  });

  describe('no-op for keys with no declared floor', () => {
    it('never throws for a tuning key, regardless of value', () => {
      for (const short of TUNING_KEYS) {
        expect(GUARDRAIL_POLICY_FLOOR_DIRECTIONS[short], short).toBeUndefined();
        expect(() => assertGuardrailPolicyFloor(fullKey(short), Number.MAX_SAFE_INTEGER, 1), short).not.toThrow();
        expect(() => assertGuardrailPolicyFloor(fullKey(short), -1, 1), short).not.toThrow();
      }
    });

    it('never throws when no platform floor is resolved yet (nothing to enforce against)', () => {
      expect(() => assertGuardrailPolicyFloor(fullKey('piiThreshold'), 0.99, undefined)).not.toThrow();
      expect(() => assertGuardrailPolicyFloor(fullKey('piiThreshold'), 0.99, null)).not.toThrow();
    });

    it('never throws for an unrecognised key', () => {
      expect(() => assertGuardrailPolicyFloor('guardrail.policy.doesNotExist' as GuardrailPolicyKey, 999, 0)).not.toThrow();
    });
  });

  it('every closed (verdict-deciding) key has a declared floor direction; every tuning key does not', () => {
    for (const short of CLOSED_KEYS) {
      expect(GUARDRAIL_POLICY_FLOOR_DIRECTIONS[short], short).toBeDefined();
    }
    for (const short of TUNING_KEYS) {
      expect(GUARDRAIL_POLICY_FLOOR_DIRECTIONS[short], short).toBeUndefined();
    }
  });
});
