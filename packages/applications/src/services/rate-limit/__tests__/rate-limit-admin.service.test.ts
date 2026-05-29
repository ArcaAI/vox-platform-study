import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ValueType } from '@arcaai/domains';
import { RateLimitAdminService } from '../rate-limit-admin.service';

const cache = new Map<string, { id: string; version: number }>();
const values = new Map<string, unknown>();

const appSettings = {
  getFromCache: vi.fn((k: string) => cache.get(k)),
  getValueFromCache: vi.fn((k: string) => (values.has(k) ? values.get(k) : null)),
  getValueWithDefault: vi.fn((k: string, d: unknown) => (values.has(k) ? values.get(k) : d)),
  hasSetting: vi.fn((k: string) => values.has(k)),
  getAllKeys: vi.fn(() => Array.from(values.keys())),
  getCacheStats: vi.fn(),
  cacheAppSettings: vi.fn(),
  updateCacheAppSettings: vi.fn(),
  refreshCache: vi.fn().mockResolvedValue(undefined),
  stopCacheRefresh: vi.fn(),
  validateSettingValue: vi.fn(() => true),
};

const globalSettings = {
  update: vi.fn().mockResolvedValue({}),
  create: vi.fn().mockResolvedValue({}),
};

const makeService = () => new RateLimitAdminService(globalSettings as any, appSettings as any);

describe('RateLimitAdminService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();
    values.clear();
  });

  describe('setEnabled', () => {
    it('updates the seeded row by id with the cached version, then refreshes the cache', async () => {
      cache.set('rate-limit.enabled', { id: 'gs-enabled', version: 7 });
      await makeService().setEnabled(false);

      expect(globalSettings.update).toHaveBeenCalledWith('gs-enabled', {
        value: 'false',
        expectedVersion: 7,
      });
      expect(globalSettings.create).not.toHaveBeenCalled();
      expect(appSettings.refreshCache).toHaveBeenCalledTimes(1);
    });

    it('creates the platform row when the key is missing from cache', async () => {
      await makeService().setEnabled(true);

      expect(globalSettings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'rate-limit.enabled',
          value: 'true',
          dataType: ValueType.Boolean,
          namespace: 'rate-limit',
          tenantId: '50000000-0000-0000-0000-000000000000',
        }),
      );
      expect(appSettings.refreshCache).toHaveBeenCalledTimes(1);
    });
  });

  describe('setTier', () => {
    it('rejects an unknown tier without writing', async () => {
      await expect(makeService().setTier('bogus', { limit: 5 })).rejects.toBeInstanceOf(BadRequestException);
      expect(globalSettings.update).not.toHaveBeenCalled();
      expect(globalSettings.create).not.toHaveBeenCalled();
    });

    it('rejects an empty payload', async () => {
      await expect(makeService().setTier('default', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-positive / non-integer limit', async () => {
      await expect(makeService().setTier('default', { limit: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(makeService().setTier('default', { limit: 1.5 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('persists a valid tier limit as an Integer row', async () => {
      cache.set('rate-limit.tier.default.limit', { id: 'gs-tier', version: 1 });
      await makeService().setTier('default', { limit: 250 });

      expect(globalSettings.update).toHaveBeenCalledWith('gs-tier', { value: '250', expectedVersion: 1 });
      expect(appSettings.refreshCache).toHaveBeenCalled();
    });
  });

  describe('setRoute', () => {
    it('rejects an unknown route', async () => {
      await expect(makeService().setRoute('does.not.exist', { limit: 5 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty payload', async () => {
      await expect(makeService().setRoute('auth.login', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('writes limit + enabled for a known route', async () => {
      await makeService().setRoute('auth.login', { limit: 3, enabled: false });

      // limit (Integer) + enabled (Boolean) → two creates (no cached rows)
      expect(globalSettings.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'rate-limit.route.auth.login.limit', value: '3', dataType: ValueType.Integer }),
      );
      expect(globalSettings.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'rate-limit.route.auth.login.enabled', value: 'false', dataType: ValueType.Boolean }),
      );
    });
  });

  describe('getPolicy', () => {
    it('reports static sources when nothing is overridden', () => {
      const policy = makeService().getPolicy();

      expect(policy.enabled).toBe(true);
      expect(policy.enabledSource).toBe('default');

      const def = policy.tiers.find((t) => t.tier === 'default')!;
      expect(def).toMatchObject({ limit: 100, ttl: 60000, limitSource: 'default' });

      const login = policy.routes.find((r) => r.routeId === 'auth.login')!;
      expect(login).toMatchObject({ limit: 5, ttl: 60000, limitSource: 'code', enabled: true });
    });

    it('reports db sources + effective values when overridden', () => {
      values.set('rate-limit.enabled', false);
      values.set('rate-limit.tier.default.limit', 999);
      values.set('rate-limit.route.auth.login.limit', 2);

      const policy = makeService().getPolicy();

      expect(policy).toMatchObject({ enabled: false, enabledSource: 'db' });
      expect(policy.tiers.find((t) => t.tier === 'default')).toMatchObject({ limit: 999, limitSource: 'db' });
      expect(policy.routes.find((r) => r.routeId === 'auth.login')).toMatchObject({ limit: 2, limitSource: 'db' });
    });
  });
});
