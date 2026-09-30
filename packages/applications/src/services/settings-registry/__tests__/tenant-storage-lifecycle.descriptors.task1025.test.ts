import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { TENANT_STORAGE_LIFECYCLE_SETTINGS } from '../descriptors/tenant-storage-lifecycle.descriptors';
import {
  TENANT_STORAGE_PURGE_CRON_KEY,
  TENANT_STORAGE_RETENTION_DAYS_KEY,
  TENANT_STORAGE_RETENTION_DEFAULTS,
  TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY,
} from '../../tenant-bucket/tenant-bucket-lifecycle.constants';

/**
 * TASK-1025 G2 (owner decision OD-2) — the retention window between a tenant's
 * deletion and the purge of its buckets is a PLATFORM setting: global-kv,
 * SYSTEM scope only, platform-admin only, 45 days by default (OD-4), bounded.
 */
describe('tenant-storage lifecycle descriptors (TASK-1025)', () => {
  const validate = (key: string, value: unknown) => HOPE_SETTINGS_REGISTRY.get(key)?.validate?.(value);

  it('registers the retention window (default 45 days, OD-4) and the purge schedule', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(TENANT_STORAGE_RETENTION_DAYS_KEY)?.default).toBe(45);
    expect(TENANT_STORAGE_RETENTION_DEFAULTS.retentionDays).toBe(45);
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

  // TASK-1025 G3 — how long a measured per-tenant usage figure is reused by the upload quota check.
  it('registers the quota usage-cache window (default 300 s, 0 disables, bounded to a day)', () => {
    expect(HOPE_SETTINGS_REGISTRY.get(TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY)?.default).toBe(300);
    expect(validate(TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY, 0)).toBeUndefined();
    expect(validate(TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY, 86_400)).toBeUndefined();
    expect(validate(TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY, -1)).toEqual(expect.any(String));
    expect(validate(TENANT_STORAGE_USAGE_CACHE_SECONDS_KEY, 86_401)).toEqual(expect.any(String));
  });
});
