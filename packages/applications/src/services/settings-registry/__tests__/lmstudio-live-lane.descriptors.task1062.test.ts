// TASK-1062 D-2 A — `lmStudio.serving.liveLaneSlots`: how many of LM Studio's decode slots the
// live-documentation lane reserves in apps/text. Platform-only `global-kv`, default 2, a whole
// number of at least 1. Its upper bound at write time is the parallel key's own (64); the
// "never above `lmStudio.serving.parallel`" rule is applied where both are read together
// (effective-config for text), because a descriptor validates one value.
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import {
  LM_STUDIO_LIVE_LANE_SLOTS_DEFAULT,
  LM_STUDIO_LIVE_LANE_SLOTS_KEY,
  LM_STUDIO_SERVING_DEFAULTS,
} from '../descriptors/lmstudio-serving.descriptors';

const KEY = 'lmStudio.serving.liveLaneSlots';

describe('TASK-1062 — the live-lane admission budget descriptor', () => {
  it('is registered as a platform-only global-kv number defaulting to 2', () => {
    expect(LM_STUDIO_LIVE_LANE_SLOTS_KEY).toBe(KEY);
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(KEY);
    expect(d.tier).toBe('global-kv');
    expect(d.dataType).toBe('number');
    expect(d.default).toBe(2);
    expect(LM_STUDIO_LIVE_LANE_SLOTS_DEFAULT).toBe(2);
    expect(d.maxScope).toBe('system');
    expect(d.globalOnly).toBe(true);
    expect(d.failMode).toBe('open-to-default');
    expect(d.consumedBy).toBeUndefined();
    expect(d.description).toMatch(/X-Hope-Lane: live/);
    expect(d.description).toMatch(/lmStudio\.serving\.parallel/);
  });

  it('accepts 1..64 whole numbers and refuses anything else', () => {
    const validate = (value: unknown) => HOPE_SETTINGS_REGISTRY.getOrThrow(KEY).validate?.(value);
    expect(validate(1)).toBeUndefined();
    expect(validate(2)).toBeUndefined();
    expect(validate(64)).toBeUndefined();
    expect(validate(0)).toMatch(/whole number/);
    expect(validate(65)).toMatch(/whole number/);
    expect(validate(1.5)).toMatch(/whole number/);
    expect(validate('2')).toMatch(/whole number/);
  });

  it('is not one of the LM Studio pod`s boot-plan keys', () => {
    expect(Object.keys(LM_STUDIO_SERVING_DEFAULTS)).not.toContain(KEY);
  });
});
