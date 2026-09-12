/**
 * `metering.storageSnapshot.*` (TASK-959 §5.2).
 *
 * The two facts worth pinning are the two that are easy to "tidy" into
 * something wrong: the switch defaults ON (every sibling sweep defaults OFF,
 * and the reason this one differs is a property of the measure, not an
 * oversight), and it is deliberately not a `killSwitch` (whose registry
 * invariant would then force it OFF).
 */
import { describe, expect, it } from 'vitest';

import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { METERING_STORAGE_SETTINGS } from '../descriptors/metering-storage.descriptors';
import { STORAGE_SNAPSHOT_CRON_KEY, STORAGE_SNAPSHOT_DEFAULTS, STORAGE_SNAPSHOT_ENABLED_KEY } from '../../storage-snapshot/storage-snapshot.constants';

describe('metering.storageSnapshot descriptors', () => {
  it('registers both keys in the assembled catalog', () => {
    for (const key of [STORAGE_SNAPSHOT_ENABLED_KEY, STORAGE_SNAPSHOT_CRON_KEY]) {
      expect(HOPE_SETTINGS_REGISTRY.get(key), `${key} is not registered`).toBeDefined();
    }
  });

  it('defaults ON — a night the job misses is permanently unbilled, not a cold cache', () => {
    const enabled = HOPE_SETTINGS_REGISTRY.get(STORAGE_SNAPSHOT_ENABLED_KEY)!;
    expect(enabled.default).toBe(true);
    expect(STORAGE_SNAPSHOT_DEFAULTS.enabled).toBe(true);
  });

  it('is NOT a kill-switch, so the registry never forces it OFF', () => {
    const enabled = HOPE_SETTINGS_REGISTRY.get(STORAGE_SNAPSHOT_ENABLED_KEY)!;
    expect(enabled.killSwitch).toBeUndefined();
    // The governance lister throws if any kill-switch defaults ON; this
    // asserts the catalog as a whole still satisfies that invariant.
    expect(() => HOPE_SETTINGS_REGISTRY.killSwitches()).not.toThrow();
  });

  it('is platform plumbing: global-kv, system scope, global-only', () => {
    for (const descriptor of METERING_STORAGE_SETTINGS) {
      expect(descriptor.tier).toBe('global-kv');
      expect(descriptor.maxScope).toBe('system');
      expect(descriptor.globalOnly).toBe(true);
      expect(descriptor.failMode).toBe('open-to-default');
    }
  });

  it('schedules past midnight so the day being measured is already closed', () => {
    const cron = HOPE_SETTINGS_REGISTRY.get(STORAGE_SNAPSHOT_CRON_KEY)!;
    expect(cron.default).toBe('15 2 * * *');
  });
});
