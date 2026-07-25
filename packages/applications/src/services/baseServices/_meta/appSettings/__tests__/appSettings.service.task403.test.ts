/**
 * The AppSettings flat cache must be DETERMINISTIC when a platform
 * key has tenant-cloned duplicates: the PLATFORM row always wins the Map.
 *
 * Why: tenant provisioning (`provisionTenantConfigs`) clones every `__GLOBAL__`
 * setting — including platform-only namespaces like `rate-limit.*` — into each
 * new tenant. The cache populate loop was last-row-wins across ALL tenants, so
 * any provisioned tenant could shadow the platform row (the boot
 * invariant only guards duplicates WITHIN the platform tenant). Symptom that
 * surfaced this: `PUT /admin/rate-limit/enabled`
 * resolved the row id from the cache winner — a TENANT clone — and the
 * tenant-scoped update then 404'd; `GET /admin/rate-limit` reported the
 * clone's value instead of the platform row's.
 *
 * Pins:
 *   - platform row wins over a tenant clone in BOTH orderings;
 *   - (TASK-558 M4) a key that exists ONLY on customer tenants is not cached;
 *   - (TASK-558 M4) two tenant clones without a platform row cache nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppSettingsService } from '../appSettings.service';
import { GlobalSettingFactory, ValueType } from '@arcaai/domains';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const TENANT_A = '019f1bf5-21b6-7365-a5fc-4f271716b17a';
const TENANT_B = '019f1c5d-9325-7258-a7c1-e462088a9e69';
const KEY = 'rate-limit.enabled';

const buildSetting = (tenantId: string, value: string) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId,
    key: KEY,
    value,
    dataType: ValueType.Boolean,
    defaultValue: '',
    name: KEY,
    namespace: 'rate-limit',
    description: '',
    locked: false,
  });

const repo = { findAll: vi.fn() };
const events = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };
const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

const buildService = () => new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);

describe('AppSettingsService — platform row wins over tenant clones', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'production';
  });

  it('serves the PLATFORM row when a tenant clone comes after it (platform first)', async () => {
    repo.findAll.mockResolvedValue([buildSetting(GLOBAL_TENANT_ID, 'true'), buildSetting(TENANT_A, 'false')]);
    const svc = buildService();

    await svc.cacheAppSettings();

    expect(svc.getValueWithDefault<boolean>(KEY, false)).toBe(true);
    expect(svc.getFromCache(KEY)?.tenantId).toBe(GLOBAL_TENANT_ID);
  });

  it('serves the PLATFORM row when tenant clones come BEFORE it (reverse ordering)', async () => {
    repo.findAll.mockResolvedValue([
      buildSetting(TENANT_A, 'false'),
      buildSetting(TENANT_B, 'false'),
      buildSetting(GLOBAL_TENANT_ID, 'true'),
    ]);
    const svc = buildService();

    await svc.cacheAppSettings();

    expect(svc.getValueWithDefault<boolean>(KEY, false)).toBe(true);
    expect(svc.getFromCache(KEY)?.tenantId).toBe(GLOBAL_TENANT_ID);
  });

  // SUPERSEDED by TASK-558 §9.3 M4. The two cases below previously pinned the
  // residual behaviour this ticket deliberately left alone ("unchanged"): a key
  // with no platform row still resolved to a CUSTOMER tenant's row. That is the
  // cross-tenant leak M4 names — for a platform-only namespace like
  // `rate-limit.*` it means one tenant's value governs the whole platform, and
  // the `getFromCache(key)` → `update(row.id)` admin-write path mutates that
  // tenant's row. The cache now admits platform-reserved tenants only, so a
  // customer row is never cached at all. See
  // `appSettings.service.tenant-key-leak.test.ts`.
  it('does NOT cache a key that only exists on customer tenants', async () => {
    repo.findAll.mockResolvedValue([buildSetting(TENANT_A, 'false')]);
    const svc = buildService();

    await svc.cacheAppSettings();

    expect(svc.hasSetting(KEY)).toBe(false);
    expect(svc.getFromCache(KEY)).toBeUndefined();
  });

  it('caches neither of two tenant clones when no platform row exists', async () => {
    repo.findAll.mockResolvedValue([buildSetting(TENANT_A, 'false'), buildSetting(TENANT_B, 'true')]);
    const svc = buildService();

    await svc.cacheAppSettings();

    expect(svc.getFromCache(KEY)).toBeUndefined();
  });
});
