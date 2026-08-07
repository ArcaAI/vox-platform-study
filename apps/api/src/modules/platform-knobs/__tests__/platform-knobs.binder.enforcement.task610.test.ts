// TASK-610 §4C — the binder is what connects `origin.enforcementEnabled` to the
// pre-bootstrap CORS code, exactly as it already connects `logLevel` to the
// logger: lazily, per call, so a settings write takes effect with no restart.
//
// The failure mode this file exists for is SILENT in both directions. A binder
// that resolved the value ONCE at init would leave the switch permanently stuck
// at whatever the cache held at boot (an operator's write would appear to do
// nothing), and a binder that let a settings error escape would take the switch
// to "enabled" by accident and start refusing browser traffic on a fresh
// database — the lock-out §4C exists to prevent.
import type { TenantSettingsService } from '@arcaai/applications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isOriginAllowed, isOriginEnforcementEnabled, setOriginEnforcementResolver, setOriginRegistryResolver } from '../../../cors.config';
import { PlatformKnobsBinder } from '../platform-knobs.binder';

/** Only `resolvePlatform` is exercised; the rest of the service is irrelevant here. */
const fakeSettings = (resolve: (key: string) => unknown): TenantSettingsService =>
  ({
    resolvePlatform: (key: string) => ({ value: resolve(key) }),
  }) as unknown as TenantSettingsService;

describe('PlatformKnobsBinder — origin enforcement resolver (TASK-610 §4C)', () => {
  beforeEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
  });

  afterEach(() => {
    setOriginRegistryResolver(null);
    setOriginEnforcementResolver(null);
    vi.restoreAllMocks();
  });

  it('leaves enforcement OFF when no settings resolver is wired at all', () => {
    new PlatformKnobsBinder().onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(false);
    expect(isOriginAllowed('https://anything.example.com', 'production')).toBe(true);
  });

  it('resolves `origin.enforcementEnabled` from the settings service', () => {
    const keys: string[] = [];
    new PlatformKnobsBinder(
      fakeSettings((key) => {
        keys.push(key);
        return key === 'origin.enforcementEnabled' ? true : 'info';
      }),
    ).onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(true);
    expect(keys).toContain('origin.enforcementEnabled');
  });

  it('keeps enforcement OFF when the setting resolves false — the descriptor default on a fresh database', () => {
    new PlatformKnobsBinder(fakeSettings(() => false)).onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(false);
  });

  it('re-reads the setting on EVERY call, so a write applies without a restart', () => {
    let enabled = false;
    new PlatformKnobsBinder(fakeSettings((key) => (key === 'origin.enforcementEnabled' ? enabled : 'info'))).onModuleInit();

    expect(isOriginEnforcementEnabled()).toBe(false);
    enabled = true;
    expect(isOriginEnforcementEnabled()).toBe(true);
  });

  it('stays OFF when the settings lookup throws — never fails INTO enforcement', () => {
    new PlatformKnobsBinder(
      fakeSettings((key) => {
        if (key === 'origin.enforcementEnabled') throw new Error('settings cache exploded');
        return 'info';
      }),
    ).onModuleInit();

    expect(() => isOriginEnforcementEnabled()).not.toThrow();
    expect(isOriginEnforcementEnabled()).toBe(false);
  });
});
