/**
 * TASK-993 lane J, item 1 (defect D-2) — the breach posture as a governed
 * setting rather than a literal.
 *
 * `rate-limit.lockout.enabled` decides whether one request over the line
 * refuses the bucket for a FULL window measured from the breach (the
 * pre-TASK-993 behaviour) or only until the current window rolls. It is a
 * `global-kv` descriptor, resolved off the same O(1) `AppSettingsService`
 * cache as every other rate-limit knob, and its code default is OFF — the
 * more forgiving of the two — so an unreadable row can never invent a
 * lockout.
 *
 * Why a boolean and not a duration is measured and recorded in
 * `rate-limit.constants.ts#RATE_LIMIT_LOCKOUT_ENABLED_DEFAULT` and proven in
 * `apps/api/src/modules/throttle/__tests__/window-only-storage.task993.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { RateLimitSettingsService } from '../rate-limit-settings.service';
import { RATE_LIMIT_LOCKOUT_ENABLED_DEFAULT, RATE_LIMIT_NO_LOCKOUT_BLOCK_MS, rateLimitLockoutEnabledKey } from '../rate-limit.constants';

function makeAppSettings(map: Record<string, unknown>): IAppSettingsService {
  return {
    getFromCache: () => undefined,
    getValueFromCache: (key: string) => (key in map ? map[key] : null),
    getValueWithDefault: <T>(key: string, def: T): T => (key in map ? (map[key] as T) : def),
    hasSetting: (key: string) => key in map,
    getAllKeys: () => Object.keys(map),
    getCacheStats: () => ({ lastRefresh: new Date(), refreshCount: 0, errorCount: 0, settingsCount: 0, isInitialized: true }),
    cacheAppSettings: async () => undefined,
    updateCacheAppSettings: () => undefined,
    refreshCache: async () => undefined,
    stopCacheRefresh: () => undefined,
    validateSettingValue: () => true,
  } as IAppSettingsService;
}

const KEY = rateLimitLockoutEnabledKey();

describe('rate-limit.lockout.enabled', () => {
  it('ships OFF — a breach costs the remainder of the window, not a fixed minute', () => {
    expect(RATE_LIMIT_LOCKOUT_ENABLED_DEFAULT).toBe(false);
    expect(new RateLimitSettingsService(makeAppSettings({})).isLockoutEnabled()).toBe(false);
  });

  it('an operator can put the full-window lockout back without a deploy', () => {
    expect(new RateLimitSettingsService(makeAppSettings({ [KEY]: true })).isLockoutEnabled()).toBe(true);
  });

  it('a row that is not a true boolean degrades to OFF rather than inventing a lockout', () => {
    // `failMode: 'open-to-default'`, and the default is the forgiving side: a
    // bookkeeping failure must never refuse a clinical request for a minute.
    for (const bad of ['true', 1, null, undefined, {}]) {
      expect(new RateLimitSettingsService(makeAppSettings({ [KEY]: bad })).isLockoutEnabled(), String(bad)).toBe(false);
    }
  });

  it('is a cataloged global-kv descriptor — reachable from the admin surface, not a literal in code', () => {
    const descriptor = HOPE_SETTINGS_REGISTRY.get(KEY);
    expect(descriptor, `no descriptor registered for ${KEY}`).toBeDefined();
    expect(descriptor!.tier).toBe('global-kv');
    expect(descriptor!.dataType).toBe('boolean');
    // Platform safety posture, never a per-tenant or per-plan knob.
    expect(descriptor!.maxScope).toBe('system');
    expect(descriptor!.globalOnly).toBe(true);
    expect(descriptor!.failMode).toBe('open-to-default');
    expect(descriptor!.default).toBe(RATE_LIMIT_LOCKOUT_ENABLED_DEFAULT);
  });

  it('names the "no lockout" block duration rather than spelling 0 at the call site', () => {
    // The guard passes this to the storage; the storage is the only thing that
    // may see it, because neither backend can honour a literal 0 (Redis throws,
    // the in-memory store stops limiting).
    expect(RATE_LIMIT_NO_LOCKOUT_BLOCK_MS).toBe(0);
  });
});
