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
    // TASK-1051: a ninth descriptor (`residency.shadowReviewedAt`, a string date record) joined the
    // family; the eight TASK-1005 knobs are still asserted exactly as before, the new one separately below.
    const knobs = MODEL_RESIDENCY_SETTINGS.filter((d) => d.key !== 'residency.shadowReviewedAt');
    expect(knobs).toHaveLength(8);
    expect(MODEL_RESIDENCY_SETTINGS).toHaveLength(9);
    for (const descriptor of knobs) {
      expect(descriptor, descriptor.key).toMatchObject({
        tier: 'global-kv',
        maxScope: 'system',
        globalOnly: true,
        failMode: 'open-to-default',
        sensitivity: 'internal',
      });
    }
  });

  it('`residency.shadowReviewedAt` is a SYSTEM-only string date record, default null, validated as ISO 8601 (TASK-1051)', () => {
    const d = MODEL_RESIDENCY_SETTINGS.find((x) => x.key === 'residency.shadowReviewedAt');
    expect(d).toMatchObject({ tier: 'global-kv', maxScope: 'system', globalOnly: true, failMode: 'open-to-default', dataType: 'string', default: null });
    expect(HOPE_SETTINGS_REGISTRY.get('residency.shadowReviewedAt')?.default).toBeNull();
    expect(d?.validate?.(null)).toBeUndefined();
    expect(d?.validate?.('2026-10-14')).toBeUndefined();
    expect(d?.validate?.('yesterday')).toEqual(expect.any(String));
    expect(d?.validate?.(5)).toEqual(expect.any(String));
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
