/**
 * Boot-time invariant pin.
 *
 * AppSettingsService.cacheAppSettings() builds a Map<key, entity>.
 * If multiple GlobalSetting rows share the same key under the
 * SYSTEM_TENANT_ID, the cache silently resolves to whichever row
 * happens to be last — a cross-tenant collision.
 *
 * The fix: detect duplicates at boot, throw, refuse to start.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppSettingsService } from '../appSettings.service';
import { GlobalSettingFactory, ValueType } from '@arcaai/domains';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const buildSetting = (key: string, tenantId: string) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId,
    key,
    value: 'v',
    dataType: ValueType.String,
    defaultValue: 'd',
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
const scheduler = {
  addCronJob: vi.fn(),
  getCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
};

describe('AppSettingsService — Phase 0 Item 5 boot-time invariant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APP_SETTINGS_BOOT_INVARIANT;
    process.env.NODE_ENV = 'production';
  });

  it('throws when >1 row exists for the SAME platform key', async () => {
    repo.findAll.mockResolvedValue([buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID), buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID)]);
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
    await expect(svc.cacheAppSettings()).rejects.toThrow(/duplicate platform key/i);
  });

  it('does NOT throw when duplicates are tenant-scoped (different tenantIds)', async () => {
    repo.findAll.mockResolvedValue([buildSetting('enable-x', 'tenant-a'), buildSetting('enable-x', 'tenant-b')]);
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
    await expect(svc.cacheAppSettings()).resolves.toBeUndefined();
  });

  it('bypasses invariant in dev with APP_SETTINGS_BOOT_INVARIANT=skip', async () => {
    process.env.NODE_ENV = 'development';
    process.env.APP_SETTINGS_BOOT_INVARIANT = 'skip';
    repo.findAll.mockResolvedValue([buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID), buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID)]);
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
    await expect(svc.cacheAppSettings()).resolves.toBeUndefined();
  });

  it('NEVER bypasses invariant in production, even with APP_SETTINGS_BOOT_INVARIANT=skip', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_SETTINGS_BOOT_INVARIANT = 'skip';
    repo.findAll.mockResolvedValue([buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID), buildSetting('crypto.saltRounds', SYSTEM_TENANT_ID)]);
    const svc = new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);
    await expect(svc.cacheAppSettings()).rejects.toThrow(/duplicate platform key/i);
  });
});
