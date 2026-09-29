// TASK-1019 D-4 — the two `global-kv` knobs behind a model download. Registered as
// platform-only, fail-open tuning knobs, and the producer's own fallbacks agree
// with the descriptor defaults (two defaults for one key is a silent divergence).
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import {
  MODEL_DOWNLOAD_SETTING_DEFAULTS,
  MODEL_DOWNLOAD_SETTING_KEYS,
  readModelDownloadSettings,
} from '../../ai-model/lifecycle/model-download-settings';

const KEYS = [MODEL_DOWNLOAD_SETTING_KEYS.staleAfterSeconds, MODEL_DOWNLOAD_SETTING_KEYS.maxAttempts];

describe('model-download descriptors', () => {
  it('registers both keys as platform-only global-kv knobs, fail-open', () => {
    for (const key of KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.get(key);
      expect(d, `${key} is not registered`).toBeDefined();
      expect(d!.tier).toBe('global-kv');
      expect(d!.maxScope).toBe('system');
      expect(d!.globalOnly).toBe(true);
      expect(d!.failMode).toBe('open-to-default');
      expect(d!.dataType).toBe('number');
      expect(d!.killSwitch).toBeUndefined();
      expect(d!.label).toBeTruthy();
      expect(d!.description).toBeTruthy();
    }
  });

  it('declares the defaults the producer falls back to (300 s stale, 3 attempts)', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(MODEL_DOWNLOAD_SETTING_KEYS.staleAfterSeconds)!.default).toBe(300);
    expect(HOPE_SETTINGS_REGISTRY.get(MODEL_DOWNLOAD_SETTING_KEYS.maxAttempts)!.default).toBe(3);
    expect(MODEL_DOWNLOAD_SETTING_DEFAULTS).toEqual({ staleAfterSeconds: 300, maxAttempts: 3 });
    expect(readModelDownloadSettings(undefined)).toEqual({ staleAfterMs: 300_000, maxAttempts: 3 });
  });

  it('refuses a non-positive value at write time', () => {
    for (const key of KEYS) {
      const validate = HOPE_SETTINGS_REGISTRY.get(key)!.validate!;
      expect(validate(0)).toBeTruthy();
      expect(validate(-5)).toBeTruthy();
      expect(validate(1.5)).toBeTruthy();
      expect(validate(10)).toBeUndefined();
    }
  });

  it('a malformed stored value falls back to the default rather than disabling the rule', () => {
    const source = { getValueWithDefault: <T>(_k: string, _f: T): T => 'soon' as unknown as T };
    expect(readModelDownloadSettings(source)).toEqual({ staleAfterMs: 300_000, maxAttempts: 3 });
  });
});
