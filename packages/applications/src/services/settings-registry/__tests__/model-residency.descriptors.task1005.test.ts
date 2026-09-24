import { describe, expect, it } from 'vitest';
import { MODEL_RESIDENCY_DEFAULTS, MODEL_RESIDENCY_SETTINGS } from '../descriptors/model-residency.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';

/**
 * TASK-1005 §5.2 — the residency controller's SYSTEM knobs, plus the
 * `stt.warmDefaultAsrOnBoot` key STT has read since TASK-985 with no
 * descriptor behind it (so no admin path could set it).
 */
describe('model-residency descriptors (TASK-1005)', () => {
  const expected: Record<string, unknown> = {
    'residency.enforce': false,
    'residency.headroomPercent': 15,
    'residency.minResidencySeconds': 300,
    'residency.reloadCooldownSeconds': 120,
    'residency.promotion.rateThreshold': 2,
    'residency.promotion.windows': 6,
    'residency.admission.maxWaitMs': 5000,
    'stt.warmDefaultAsrOnBoot': false,
  };

  it('registers exactly the eight keys with the plan defaults — enforcement OFF (shadow mode, D-3)', () => {
    expect(MODEL_RESIDENCY_DEFAULTS).toEqual(expected);
    for (const [key, value] of Object.entries(expected)) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)?.default, key).toEqual(value);
    }
  });

  it('every key is a SYSTEM-only, platform-admin, global-kv, open-to-default tuning knob', () => {
    expect(MODEL_RESIDENCY_SETTINGS).toHaveLength(8);
    for (const descriptor of MODEL_RESIDENCY_SETTINGS) {
      expect(descriptor, descriptor.key).toMatchObject({
        tier: 'global-kv',
        maxScope: 'system',
        globalOnly: true,
        failMode: 'open-to-default',
        sensitivity: 'internal',
      });
    }
  });

  it('puts `stt.warmDefaultAsrOnBoot` on the stt effective-config pull (where STT reads it) and nothing else', () => {
    const consumed = MODEL_RESIDENCY_SETTINGS.filter((d) => d.consumedBy?.length);
    expect(consumed.map((d) => [d.key, d.consumedBy])).toEqual([['stt.warmDefaultAsrOnBoot', ['stt']]]);
  });

  it('refuses out-of-range writes rather than clamping them', () => {
    const validate = (key: string, value: unknown) => HOPE_SETTINGS_REGISTRY.get(key)?.validate?.(value);
    expect(validate('residency.headroomPercent', 95)).toEqual(expect.any(String));
    expect(validate('residency.headroomPercent', 15)).toBeUndefined();
    expect(validate('residency.promotion.windows', 0)).toEqual(expect.any(String));
    expect(validate('residency.promotion.rateThreshold', -1)).toEqual(expect.any(String));
    expect(validate('residency.admission.maxWaitMs', 60_001)).toEqual(expect.any(String));
  });
});
