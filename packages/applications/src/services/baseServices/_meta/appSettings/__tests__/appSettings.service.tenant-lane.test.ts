/**
 * The TENANT lane of the app-settings cache.
 *
 * A cache keyed by setting KEY ALONE is only sound while its
 * contents are platform-only, and `_cachedAppSettings` is restricted accordingly.
 * Per-tenant overrides for the `maxScope: 'tenant'` knobs moved
 * into the database, which means a SECOND map — and the tenant id
 * must be part of its key, not an attribute of its value.
 *
 * The contract pinned here:
 *   1. the platform (key-only) map is UNCHANGED — no customer row may enter it;
 *   2. tenant overrides live in a `${tenantId}::${key}` map, so tenant A's value
 *      is unreachable from tenant B's lookup;
 *   3. only the reserved `registry` namespace populates the tenant map, so the
 *      ~18 cloned per-tenant seed rows of every tenant do not bloat it;
 *   4. both maps are replaced atomically by the same refresh, so the existing
 *      `app-settings:invalidate` fan-out converges the tenant lane for free.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppSettingsService } from '../appSettings.service';
import { GlobalSettingFactory, ValueType } from '@arcaai/domains';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const CUSTOMER_TENANT_A = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_TENANT_B = '22222222-2222-2222-2222-222222222222';

const buildSetting = (key: string, tenantId: string, value: string, namespace = 'registry', dataType = ValueType.Integer) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId,
    key,
    value,
    dataType,
    defaultValue: value,
    name: key,
    namespace,
    description: '',
    locked: false,
  });

const repo = { findAll: vi.fn() };
const events = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn(),
  // `cacheAppSettings` reads outside the request CLS context; pass through.
  exit: <T,>(fn: () => T): T => fn(),
};
const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

const newService = () => new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);

describe('AppSettingsService — tenant lane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APP_SETTINGS_BOOT_INVARIANT;
    process.env.NODE_ENV = 'production';
  });

  it('serves a tenant override to THAT tenant only', async () => {
    repo.findAll.mockResolvedValue([
      buildSetting('rateLimit.maxRequests', GLOBAL_TENANT_ID, '100'),
      buildSetting('rateLimit.maxRequests', CUSTOMER_TENANT_A, '10'),
    ]);

    const service = newService();
    await service.cacheAppSettings();

    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'rateLimit.maxRequests')).toBe(10);
    // The headline isolation property: B never sees A's row.
    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_B, 'rateLimit.maxRequests')).toBeNull();
    // …and the platform lane is untouched by either.
    expect(service.getValueFromCache('rateLimit.maxRequests')).toBe(100);
  });

  it('keeps two tenants overriding the SAME key independent', async () => {
    repo.findAll.mockResolvedValue([
      buildSetting('rateLimit.maxRequests', GLOBAL_TENANT_ID, '100'),
      buildSetting('rateLimit.maxRequests', CUSTOMER_TENANT_A, '10'),
      buildSetting('rateLimit.maxRequests', CUSTOMER_TENANT_B, '55'),
    ]);

    const service = newService();
    await service.cacheAppSettings();

    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'rateLimit.maxRequests')).toBe(10);
    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_B, 'rateLimit.maxRequests')).toBe(55);
  });

  it('does NOT let a tenant row leak into the platform (key-only) map', async () => {
    repo.findAll.mockResolvedValue([buildSetting('rateLimit.maxRequests', CUSTOMER_TENANT_A, '10')]);

    const service = newService();
    await service.cacheAppSettings();

    expect(service.getValueFromCache('rateLimit.maxRequests')).toBeNull();
    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'rateLimit.maxRequests')).toBe(10);
  });

  it('admits ONLY the reserved `registry` namespace into the tenant map', async () => {
    repo.findAll.mockResolvedValue([
      // A per-tenant clone from seed 11 — must NOT become a registry override.
      buildSetting('enable-local-raw-capture', CUSTOMER_TENANT_A, 'true', 'feature-flags', ValueType.Boolean),
      buildSetting('rateLimit.maxRequests', CUSTOMER_TENANT_A, '10'),
    ]);

    const service = newService();
    await service.cacheAppSettings();

    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'enable-local-raw-capture')).toBeNull();
    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'rateLimit.maxRequests')).toBe(10);
  });

  it('drops a tenant override that was removed, on the next refresh', async () => {
    repo.findAll.mockResolvedValue([buildSetting('rateLimit.maxRequests', CUSTOMER_TENANT_A, '10')]);
    const service = newService();
    await service.cacheAppSettings();
    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'rateLimit.maxRequests')).toBe(10);

    repo.findAll.mockResolvedValue([]);
    await service.refreshCache();
    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'rateLimit.maxRequests')).toBeNull();
  });

  it('returns null for an uninitialized cache rather than throwing', () => {
    const service = newService();
    expect(service.getTenantValueFromCache(CUSTOMER_TENANT_A, 'rateLimit.maxRequests')).toBeNull();
  });
});
