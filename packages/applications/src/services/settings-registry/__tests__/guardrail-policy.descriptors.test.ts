// Guardrail policy descriptors.
//
// Covers: registration/shape, the failMode split (closed for anything that
// decides a verdict, open-to-default for pure tuning), and the tighten-only
// floor (D2) — a looser tenant write is REJECTED (403), never clamped.
//
// The cascade and the floor are no longer this file's own code. Both were
// orphans — `resolveGuardrailPolicyValue` and `assertGuardrailPolicyFloor` had
// zero callers outside this test — so the cascade is now the shared `global-kv`
// lane (`TenantSettingsService`, which walks tenant → SYSTEM → failMode for
// every registry key) and the floor is `assertTightenOnlyFloor`, driven off the
// `floorDirection` each descriptor declares and enforced once in the write
// lane. What is asserted here is that the DECLARATIONS are right; the shared
// mechanisms have their own tests.

import { describe, expect, it } from 'vitest';
import {
  GUARDRAIL_POLICY_DEFAULTS,
  GUARDRAIL_POLICY_FLOOR_DIRECTIONS,
  GUARDRAIL_POLICY_SETTINGS,
  GuardrailPolicyKey,
  GuardrailPolicyShortKey,
} from '../descriptors/guardrail-policy.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { assertTightenOnlyFloor, SettingFloorViolation } from '../tenant-clamp';

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

  it('is tier global-kv, tenant-scoped, and NOT super-admin-only (tenant may tighten its own row)', () => {
    for (const d of GUARDRAIL_POLICY_SETTINGS) {
      // `global-kv` per owner decision D-2: the only tier with a complete
      // read + write + cascade + invalidate loop. `db-config` is reserved for
      // values with their own table, and these keys have none — which is why,
      // under that tier, all 13 were unreachable by any admin.
      expect(d.tier, d.key).toBe('global-kv');
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

describe('guardrail policy descriptors — channel discipline (owner decision D-1)', () => {
  // These keys are `maxScope: 'tenant'`, so they vary BY TENANT. The pull route
  // caches ONE platform snapshot per service process; putting a tenant-varying
  // key on it would turn that into one entry per customer. They travel PUSH.
  it('declares NO consumedBy — a tenant-varying key never rides the platform pull route', () => {
    for (const d of GUARDRAIL_POLICY_SETTINGS) {
      expect(d.consumedBy, d.key).toBeUndefined();
    }
  });
});

describe('guardrail policy descriptors — the tighten-only floor is DECLARED, not hand-wired', () => {
  it('declares floorDirection on exactly the verdict-deciding keys', () => {
    for (const short of SHORT_KEYS) {
      const declared = HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey(short)).floorDirection;
      expect(declared, short).toBe(GUARDRAIL_POLICY_FLOOR_DIRECTIONS[short]);
    }
  });

  it('declares no floor on any pure-tuning key (nothing about them decides a verdict)', () => {
    for (const short of TUNING_KEYS) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey(short)).floorDirection, short).toBeUndefined();
    }
  });

  describe('lower-is-stricter thresholds (a LOWER score catches more content)', () => {
    it('permits an equal or tighter value', () => {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('piiThreshold'));
      expect(() => assertTightenOnlyFloor(d, 0.5, 0.5)).not.toThrow();
      expect(() => assertTightenOnlyFloor(d, 0.3, 0.5)).not.toThrow();
    });

    it('REJECTS a looser value — 403, not a silent clamp', () => {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('piiThreshold'));
      expect(() => assertTightenOnlyFloor(d, 0.9, 0.5)).toThrow(SettingFloorViolation);
      expect(() => assertTightenOnlyFloor(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('classificationThreshold')), 0.8, 0.4)).toThrow(
        SettingFloorViolation,
      );
    });
  });

  describe('higher-is-stricter gates (a HIGHER score makes a positive claim harder to earn)', () => {
    it('permits an equal or tighter value', () => {
      expect(() => assertTightenOnlyFloor(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('guardianMinConfidence')), 0.75, 0.75)).not.toThrow();
      expect(() => assertTightenOnlyFloor(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('entailmentThreshold')), 0.9, 0.5)).not.toThrow();
    });

    it('REJECTS a looser value', () => {
      expect(() => assertTightenOnlyFloor(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('guardianMinConfidence')), 0.5, 0.75)).toThrow(
        SettingFloorViolation,
      );
      expect(() => assertTightenOnlyFloor(HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('entailmentThreshold')), 0.2, 0.5)).toThrow(SettingFloorViolation);
    });
  });

  describe('superset-is-stricter taxonomies (a tenant may ADD categories, never drop one)', () => {
    const floor = [...GUARDRAIL_POLICY_DEFAULTS.harmfulLabels];

    it('permits the same set, or a superset', () => {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('harmfulLabels'));
      expect(() => assertTightenOnlyFloor(d, [...floor], floor)).not.toThrow();
      expect(() => assertTightenOnlyFloor(d, [...floor, 'self_harm'], floor)).not.toThrow();
    });

    it('REJECTS a set that drops a platform-mandated category', () => {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('harmfulLabels'));
      expect(() => assertTightenOnlyFloor(d, floor.filter((l) => l !== 'hate_speech'), floor)).toThrow(SettingFloorViolation);
    });
  });

  it('is a no-op for a tuning key in EITHER direction — there is nothing to floor', () => {
    for (const short of TUNING_KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey(short));
      expect(() => assertTightenOnlyFloor(d, Number.MAX_SAFE_INTEGER, 1), short).not.toThrow();
      expect(() => assertTightenOnlyFloor(d, -1, 1), short).not.toThrow();
    }
  });

  it('treats an absent platform floor as "nothing to enforce against", not a refusal', () => {
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(fullKey('piiThreshold'));
    expect(() => assertTightenOnlyFloor(d, 0.99, undefined)).not.toThrow();
    expect(() => assertTightenOnlyFloor(d, 0.99, null)).not.toThrow();
  });
});

