// TASK-1019 I7 — the two `global-kv` knobs that bound a hung transfer in the
// model-publisher worker: the byte-idle watchdog on a Hub download, and the
// per-request timeout of the publisher's S3 client. Platform-only, fail-open
// tuning knobs; the worker's own fallbacks agree with the descriptor defaults.
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import {
  MODEL_PUBLISHER_TIMEOUT_DEFAULTS,
  MODEL_PUBLISHER_TIMEOUT_KEYS,
  readModelPublisherTimeouts,
} from '../../ai-model/publish/model-publisher-timeouts.settings';

const KEYS = [MODEL_PUBLISHER_TIMEOUT_KEYS.idleTimeoutSeconds, MODEL_PUBLISHER_TIMEOUT_KEYS.requestTimeoutSeconds];

describe('model-publisher timeout descriptors (I7)', () => {
  it('uses the agreed key names', () => {
    expect(KEYS).toEqual(['modelRegistry.download.idleTimeoutSeconds', 'modelRegistry.download.requestTimeoutSeconds']);
  });

  it('registers both as platform-only global-kv knobs, fail-open', () => {
    for (const key of KEYS) {
      const d = HOPE_SETTINGS_REGISTRY.get(key);
      expect(d, `${key} is not registered`).toBeDefined();
      expect(d!.tier).toBe('global-kv');
      expect(d!.maxScope).toBe('system');
      expect(d!.globalOnly).toBe(true);
      expect(d!.failMode).toBe('open-to-default');
      expect(d!.dataType).toBe('number');
      expect(d!.label).toBeTruthy();
      expect(d!.description).toBeTruthy();
    }
  });

  it('declares the defaults the worker falls back to (120 s idle, 600 s per request)', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(MODEL_PUBLISHER_TIMEOUT_KEYS.idleTimeoutSeconds)!.default).toBe(120);
    expect(HOPE_SETTINGS_REGISTRY.get(MODEL_PUBLISHER_TIMEOUT_KEYS.requestTimeoutSeconds)!.default).toBe(600);
    expect(MODEL_PUBLISHER_TIMEOUT_DEFAULTS).toEqual({ idleTimeoutSeconds: 120, requestTimeoutSeconds: 600 });
    expect(readModelPublisherTimeouts(undefined)).toEqual({ idleTimeoutMs: 120_000, requestTimeoutMs: 600_000 });
  });

  it('refuses anything but a whole number of at least 10 seconds at write time', () => {
    for (const key of KEYS) {
      const validate = HOPE_SETTINGS_REGISTRY.get(key)!.validate!;
      expect(validate(0)).toBeTruthy();
      expect(validate(9)).toBeTruthy();
      expect(validate(12.5)).toBeTruthy();
      expect(validate('60')).toBeTruthy();
      expect(validate(10)).toBeUndefined();
      expect(validate(900)).toBeUndefined();
    }
  });

  it('a stored value below the floor or malformed falls back to the default rather than disabling the bound', () => {
    const source = (value: unknown) => ({ getValueWithDefault: <T>(_k: string, _f: T): T => value as T });
    expect(readModelPublisherTimeouts(source(5))).toEqual({ idleTimeoutMs: 120_000, requestTimeoutMs: 600_000 });
    expect(readModelPublisherTimeouts(source('soon'))).toEqual({ idleTimeoutMs: 120_000, requestTimeoutMs: 600_000 });
    expect(readModelPublisherTimeouts(source(45))).toEqual({ idleTimeoutMs: 45_000, requestTimeoutMs: 45_000 });
  });
});
