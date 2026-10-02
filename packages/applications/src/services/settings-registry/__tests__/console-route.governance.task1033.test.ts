/**
 * TASK-1033 T1 — a setting whose write lives on a DEDICATED surface (`db-config`, `entitlement`,
 * `redis-flag`) must name the console route that owns that write, or the registry refuses to
 * assemble. Without it the Settings screen can only say "not editable here" — a dead end.
 */
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistry } from '../settings-registry';
import type { SettingDescriptor, StorageTier } from '../registry.types';

const descriptor = (over: Partial<SettingDescriptor>): SettingDescriptor => ({
  key: 'x.y',
  tier: 'global-kv',
  dataType: 'string',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'GlobalSetting',
  failMode: 'open-to-default',
  category: 'Platform Operations',
  ...over,
});

const DEDICATED: StorageTier[] = ['db-config', 'entitlement', 'redis-flag'];

describe('TASK-1033 — consoleRoute on dedicated-surface descriptors', () => {
  it.each(DEDICATED)('register throws for a %s descriptor without consoleRoute', (tier) => {
    expect(() => new SettingsRegistry().register(descriptor({ tier }))).toThrow(/consoleRoute/);
  });

  it.each(DEDICATED)('register accepts a %s descriptor that names its consoleRoute', (tier) => {
    expect(() => new SettingsRegistry().register(descriptor({ tier, consoleRoute: '/somewhere', consoleRouteLabel: 'Somewhere' }))).not.toThrow();
  });

  it('a global-kv descriptor needs no consoleRoute (the registry lane IS its editor)', () => {
    expect(() => new SettingsRegistry().register(descriptor({ tier: 'global-kv' }))).not.toThrow();
  });

  it('every live dedicated-surface descriptor names a route and a label', () => {
    const dedicated = HOPE_SETTINGS_REGISTRY.list().filter((d) => DEDICATED.includes(d.tier));
    expect(dedicated.length).toBeGreaterThan(0);
    for (const d of dedicated) {
      expect(d.consoleRoute, d.key).toMatch(/^\//);
      expect(d.consoleRouteLabel, d.key).toBeTruthy();
    }
    expect(HOPE_SETTINGS_REGISTRY.get('storage.platformDefault.publicEndpoint')!.consoleRoute).toBe('/tenants/storage?tab=configs');
    expect(HOPE_SETTINGS_REGISTRY.get('entitlements.featurePlatformDefaultCredential')!.consoleRoute).toBe('/entitlements');
  });
});
