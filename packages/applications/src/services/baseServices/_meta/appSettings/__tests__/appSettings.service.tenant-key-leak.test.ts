/**
 * `tenantId` MUST be part of every config cache key.
 *
 * `AppSettingsService` caches into a `Map<key, GlobalSettingEntity>` keyed by the
 * setting KEY ALONE, while `cacheAppSettings()` loads `findAll({})` — every
 * `GlobalSetting` row of EVERY tenant. Tenant provisioning
 * (`TenantService.provisionTenantConfigs`) clones the whole platform setting set
 * into each new tenant, so the cache routinely holds N_tenants rows per key that
 * all collide on one Map slot.
 *
 * The pre-existing mitigation only makes the PLATFORM row win when a platform row
 * for that key is present. It does nothing for a key with no surviving platform
 * row — then a CUSTOMER tenant's value is served to every caller of a key-only
 * read (`getValueWithDefault` / `getValueFromCache` / `getFromCache`), and every
 * one of those callers is platform-scoped (JWT TTLs, rate limits, password
 * policy, cron schedules, storage endpoints, `EffectiveSettingsService`'s
 * `global-kv` lane).
 *
 * Two reachable failure shapes are pinned here:
 *   1. READ  — the platform row is soft-deleted (or never existed) and a tenant
 *              clone survives ⇒ tenant A's value governs the platform.
 *   2. WRITE — `EntitlementsService.writeSetting` / `RateLimitAdminService`
 *              resolve the row to UPDATE via `getFromCache(key)`; a tenant row in
 *              that slot means a platform admin write mutates a TENANT's row.
 *
 * Fix: the cache admits ONLY the reserved SYSTEM tenant (`00000000-…`) — the
 * SOLE platform-configuration tier (owner ruling 2026-08-20, TASK-763 OD-1).
 * GLOBAL/default (`50000000-…`) is a CUSTOMER tenant, never a runtime tier, and
 * its rows are treated exactly like any other customer tenant's — never
 * admitted into this key-only cache. Customer-tenant rows never enter it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppSettingsService } from '../appSettings.service';
import { GlobalSettingFactory, ResourceStatusType, ValueType } from '@arcaai/domains';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const CUSTOMER_TENANT_A = '11111111-1111-1111-1111-111111111111';
const CUSTOMER_TENANT_B = '22222222-2222-2222-2222-222222222222';

const buildSetting = (key: string, tenantId: string, value: string) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId,
    key,
    value,
    dataType: ValueType.String,
    defaultValue: value,
    name: key,
    namespace: 'com.flw.test',
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

describe('AppSettingsService — M4 tenant-keyed cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APP_SETTINGS_BOOT_INVARIANT;
    process.env.NODE_ENV = 'production';
  });

  it('does NOT serve a customer tenant value when no platform row exists for the key', async () => {
    // `JWT_EXPIRES_IN` is consumed platform-wide (auth.controller, oidc.strategy).
    // Only customer-tenant clones survive here — e.g. the platform row was
    // soft-deleted, which `cacheAppSettings()` filters out before caching.
    repo.findAll.mockResolvedValue([buildSetting('JWT_EXPIRES_IN', CUSTOMER_TENANT_A, '99h')]);

    const svc = newService();
    await svc.cacheAppSettings();

    // Leak shape: tenant A's 99h becomes the platform-wide JWT lifetime.
    expect(svc.getValueWithDefault('JWT_EXPIRES_IN', '1h')).toBe('1h');
    expect(svc.hasSetting('JWT_EXPIRES_IN')).toBe(false);
  });

  it('is deterministic when two customer tenants hold the same key', async () => {
    // With a key-only Map this is plain last-row-wins: which tenant governs the
    // platform depends on repository row order.
    repo.findAll.mockResolvedValue([
      buildSetting('rate-limit.tier.default.limit', CUSTOMER_TENANT_A, '10'),
      buildSetting('rate-limit.tier.default.limit', CUSTOMER_TENANT_B, '100000'),
    ]);

    const svc = newService();
    await svc.cacheAppSettings();

    expect(svc.getValueWithDefault('rate-limit.tier.default.limit', 'unset')).toBe('unset');
  });

  it('resolves the row a platform admin write targets to a PLATFORM row, never a tenant row', async () => {
    // `EntitlementsService.writeSetting` / `RateLimitAdminService.writeSetting`
    // pick their update target with `getFromCache(key)`. A tenant row in that
    // slot turns a platform write into a cross-tenant write.
    repo.findAll.mockResolvedValue([
      buildSetting('entitlements.enabled', CUSTOMER_TENANT_A, 'false'),
      buildSetting('entitlements.enabled', SYSTEM_TENANT_ID, 'true'),
    ]);

    const svc = newService();
    await svc.cacheAppSettings();

    expect(svc.getFromCache('entitlements.enabled')?.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('keeps the reserved SYSTEM tenant cacheable as the sole platform tier', async () => {
    // Platform rows are seeded under exactly one reserved id: SYSTEM (seed 11
    // `PLATFORM_SETTINGS`, 11a platform knobs, 11c consultation gates, 12
    // rate-limit, 15 entitlements — TASK-763 OD-1 migrated all of these off
    // GLOBAL/default). Scoping the cache must not drop it.
    repo.findAll.mockResolvedValue([
      buildSetting('enable-local-raw-capture', SYSTEM_TENANT_ID, 'true'),
      buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID, '12'),
    ]);

    const svc = newService();
    await svc.cacheAppSettings();

    expect(svc.getValueWithDefault('enable-local-raw-capture', 'missing')).toBe('true');
    expect(svc.getValueWithDefault('crypto.saltRounds', 'missing')).toBe('12');
  });

  it('never treats GLOBAL (the customer playground tenant) as platform-reserved, even for a key that is genuinely platform-wide elsewhere', async () => {
    // Owner ruling 2026-08-20 (TASK-763 OD-1): the runtime cascade is request
    // tenant → SYSTEM, full stop. GLOBAL (`50000000-…`) is an ordinary CUSTOMER
    // tenant and must never outrank — or substitute for — the SYSTEM row.
    repo.findAll.mockResolvedValue([buildSetting('crypto.saltRounds', GLOBAL_TENANT_ID, '12')]);

    const svc = newService();
    await svc.cacheAppSettings();

    expect(svc.hasSetting('crypto.saltRounds')).toBe(false);
    expect(svc.getFromCache('crypto.saltRounds')).toBeUndefined();
  });

  it('still drops soft-DELETED platform rows', async () => {
    const deleted = buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID, '4');
    // `resourceStatus` is read-only on BaseEntity (mutations go through
    // setProperty/lifecycle methods), so stub the getter for this fixture.
    vi.spyOn(deleted, 'resourceStatus', 'get').mockReturnValue(ResourceStatusType.DELETED);
    repo.findAll.mockResolvedValue([deleted]);

    const svc = newService();
    await svc.cacheAppSettings();

    expect(svc.hasSetting('crypto.saltRounds')).toBe(false);
  });
});
