/**
 * TASK-403 — the AppSettings flat cache must be DETERMINISTIC when a platform
 * key has tenant-cloned duplicates: the PLATFORM row always wins the Map.
 *
 * Why: tenant provisioning (`provisionTenantConfigs`) clones every `__GLOBAL__`
 * setting — including platform-only namespaces like `rate-limit.*` — into each
 * new tenant. The cache populate loop was last-row-wins across ALL tenants, so
 * any provisioned tenant could shadow the platform row (the TASK-302 P0-5 boot
 * invariant only guards duplicates WITHIN the platform tenant). Symptom that
 * surfaced this (TASK-403 rate-limits E2E): `PUT /admin/rate-limit/enabled`
 * resolved the row id from the cache winner — a TENANT clone — and the
 * tenant-scoped update then 404'd; `GET /admin/rate-limit` reported the
 * clone's value instead of the platform row's.
 *
 * Pins:
 *   - platform row wins over a tenant clone in BOTH orderings;
 *   - a key that only exists on customer tenants is still cached (unchanged);
 *   - two tenant clones without a platform row keep last-wins (unchanged).
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

describe('AppSettingsService — TASK-403 platform row wins over tenant clones', () => {
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

  it('still caches a key that only exists on customer tenants', async () => {
    repo.findAll.mockResolvedValue([buildSetting(TENANT_A, 'false')]);
    const svc = buildService();

    await svc.cacheAppSettings();

    expect(svc.hasSetting(KEY)).toBe(true);
    expect(svc.getFromCache(KEY)?.tenantId).toBe(TENANT_A);
  });

  it('keeps last-wins between two tenant clones when no platform row exists (unchanged behavior)', async () => {
    repo.findAll.mockResolvedValue([buildSetting(TENANT_A, 'false'), buildSetting(TENANT_B, 'true')]);
    const svc = buildService();

    await svc.cacheAppSettings();

    expect(svc.getFromCache(KEY)?.tenantId).toBe(TENANT_B);
  });
});
