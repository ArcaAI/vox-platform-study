import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { TENANT_STORAGE_LIFECYCLE_SETTINGS } from '../descriptors/tenant-storage-lifecycle.descriptors';
import {
  TENANT_STORAGE_PURGE_CRON_KEY,
  TENANT_STORAGE_RETENTION_DAYS_KEY,
  TENANT_STORAGE_RETENTION_DEFAULTS,
} from '../../tenant-bucket/tenant-bucket-lifecycle.constants';

/**
 * TASK-1025 G2 (owner decision OD-2) — the retention window between a tenant's
 * deletion and the purge of its buckets is a PLATFORM setting: global-kv,
 * SYSTEM scope only, platform-admin only, 30 days by default, bounded.
 */
describe('tenant-storage lifecycle descriptors (TASK-1025)', () => {
  const validate = (key: string, value: unknown) => HOPE_SETTINGS_REGISTRY.get(key)?.validate?.(value);

  it('registers the retention window (default 30 days) and the purge schedule', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(TENANT_STORAGE_RETENTION_DAYS_KEY)?.default).toBe(30);
    expect(TENANT_STORAGE_RETENTION_DEFAULTS.retentionDays).toBe(30);
    expect(HOPE_SETTINGS_REGISTRY.get(TENANT_STORAGE_PURGE_CRON_KEY)?.default).toBe(TENANT_STORAGE_RETENTION_DEFAULTS.purgeCron);
  });

  it('every key is a SYSTEM-only, platform-admin, global-kv, open-to-default knob that no Python service reads', () => {
    for (const descriptor of TENANT_STORAGE_LIFECYCLE_SETTINGS) {
      expect(descriptor, descriptor.key).toMatchObject({
        tier: 'global-kv',
        maxScope: 'system',
        globalOnly: true,
        failMode: 'open-to-default',
        sensitivity: 'internal',
      });
      expect(descriptor.consumedBy, descriptor.key).toBeUndefined();
      expect(HOPE_SETTINGS_REGISTRY.get(descriptor.key), descriptor.key).toBeDefined();
    }
  });

  it('bounds the retention window to whole days in [1, 3650] and refuses anything else', () => {
    expect(validate(TENANT_STORAGE_RETENTION_DAYS_KEY, 30)).toBeUndefined();
    expect(validate(TENANT_STORAGE_RETENTION_DAYS_KEY, 1)).toBeUndefined();
    expect(validate(TENANT_STORAGE_RETENTION_DAYS_KEY, 3650)).toBeUndefined();
    expect(validate(TENANT_STORAGE_RETENTION_DAYS_KEY, 0)).toEqual(expect.any(String));
    expect(validate(TENANT_STORAGE_RETENTION_DAYS_KEY, -5)).toEqual(expect.any(String));
    expect(validate(TENANT_STORAGE_RETENTION_DAYS_KEY, 3651)).toEqual(expect.any(String));
    expect(validate(TENANT_STORAGE_RETENTION_DAYS_KEY, 1.5)).toEqual(expect.any(String));
  });
});
