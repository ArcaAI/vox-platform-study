import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import {
  TENANT_CHECKPOINT_DEFAULTS,
  TENANT_CHECKPOINT_MAX_LOCK_MINUTES_KEY,
  TENANT_CHECKPOINT_MAX_RETAINED_KEY,
  TENANT_CHECKPOINT_MAX_UPLOAD_GB_KEY,
  TENANT_CHECKPOINT_RETENTION_DAYS_KEY,
} from '../descriptors/tenant-checkpoint.descriptors';

const CASES = [
  [TENANT_CHECKPOINT_RETENTION_DAYS_KEY, 30, undefined],
  [TENANT_CHECKPOINT_MAX_RETAINED_KEY, 10, undefined],
  [TENANT_CHECKPOINT_MAX_UPLOAD_GB_KEY, 50, 500],
  [TENANT_CHECKPOINT_MAX_LOCK_MINUTES_KEY, 60, 240],
] as const;

describe('tenant checkpoint descriptors', () => {
  it('uses the agreed key names and defaults', () => {
    expect(TENANT_CHECKPOINT_DEFAULTS).toEqual({
      retentionDays: 30,
      maxRetained: 10,
      maxUploadSizeGb: 50,
      maxLockMinutes: 60,
    });
  });

  it.each(CASES)('registers %s as a tenant-overridable, fail-open number', (key, def, max) => {
    const d = HOPE_SETTINGS_REGISTRY.get(key);
    expect(d, `${key} is not registered`).toBeDefined();
    expect(d!.default).toBe(def);
    expect(d!.dataType).toBe('number');
    expect(d!.failMode).toBe('open-to-default');
    expect(d!.maxScope).toBe('tenant');
    expect(d!.globalOnly).toBeFalsy();
    expect(d!.validate!(def)).toBeUndefined();
    for (const bad of [0, -1, 1.5, '3', NaN]) expect(d!.validate!(bad), String(bad)).toEqual(expect.any(String));
    if (max !== undefined) {
      expect(d!.validate!(max)).toBeUndefined();
      expect(d!.validate!(max + 1)).toEqual(expect.any(String));
    }
  });
});
