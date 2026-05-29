import { describe, it, expect } from 'vitest';
import { RateLimitSettingsService } from '../rate-limit-settings.service';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';

/**
 * Build a fake IAppSettingsService backed by a flat key→parsedValue map,
 * mirroring how the real cache resolves `parsedValue` (number for Integer,
 * boolean for Boolean) and falls back to the default when a key is absent.
 */
function makeAppSettings(map: Record<string, unknown>): IAppSettingsService {
  return {
    getFromCache: () => undefined,
    getValueFromCache: (key: string) => (key in map ? map[key] : null),
    getValueWithDefault: <T,>(key: string, def: T): T => (key in map ? (map[key] as T) : def),
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

describe('RateLimitSettingsService', () => {
  describe('isEnabled', () => {
    it('defaults to true when rate-limit.enabled is unset', () => {
      const svc = new RateLimitSettingsService(makeAppSettings({}));
      expect(svc.isEnabled()).toBe(true);
    });

    it('returns false when rate-limit.enabled is set to false (boolean, not null)', () => {
      const svc = new RateLimitSettingsService(makeAppSettings({ 'rate-limit.enabled': false }));
      expect(svc.isEnabled()).toBe(false);
    });
  });

  describe('getTier', () => {
    it('falls back to the static tier baseline when no DB rows exist', () => {
      const svc = new RateLimitSettingsService(makeAppSettings({}));
      expect(svc.getTier('default')).toEqual({ limit: 100, ttl: 60000 });
      expect(svc.getTier('strict')).toEqual({ limit: 10, ttl: 60000 });
    });

    it('returns the DB value when a tier baseline is overridden', () => {
      const svc = new RateLimitSettingsService(
        makeAppSettings({ 'rate-limit.tier.default.limit': 42, 'rate-limit.tier.default.ttl': 30000 }),
      );
      expect(svc.getTier('default')).toEqual({ limit: 42, ttl: 30000 });
    });
  });

  describe('getRouteOverride', () => {
    it('returns undefined when no per-route keys are set', () => {
      const svc = new RateLimitSettingsService(makeAppSettings({}));
      expect(svc.getRouteOverride('auth.login')).toBeUndefined();
    });

    it('returns only the fields the admin set', () => {
      const svc = new RateLimitSettingsService(
        makeAppSettings({ 'rate-limit.route.auth.login.limit': 3 }),
      );
      expect(svc.getRouteOverride('auth.login')).toEqual({ limit: 3, ttl: undefined, enabled: undefined });
    });

    it('captures a per-route disable flag', () => {
      const svc = new RateLimitSettingsService(
        makeAppSettings({ 'rate-limit.route.health.enabled': false }),
      );
      expect(svc.getRouteOverride('health')).toEqual({ limit: undefined, ttl: undefined, enabled: false });
    });
  });
});
