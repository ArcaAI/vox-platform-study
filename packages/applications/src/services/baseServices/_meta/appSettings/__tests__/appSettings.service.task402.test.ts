/**
 * The AppSettings cache + boot
 * invariant must IGNORE soft-DELETED rows at the SERVICE layer.
 *
 * Why service-level: `cacheAppSettings()` reads through
 * `globalSettingRepository.findAll({})`, whose DELETED-filtering is an
 * invisible property of WHICH Prisma client variant serves the query. The
 * extended client filters; the CLS transaction client handed out inside
 * `runInTransaction` windows (and any other unextended client) does NOT.
 * A soft-delete + recreate cycle then surfaces a DELETED+ENABLED pair for
 * one platform key straight into the invariant → every refresh fails and
 * the next boot crashes. These tests feed the pair in directly (as such a
 * client would) and pin that:
 *
 *   - a DELETED+recreated key is TOLERATED (no duplicate-key throw), in
 *     BOTH array orderings;
 *   - the cache serves the ENABLED row (a DELETED row never wins the Map,
 *     regardless of ordering);
 *   - a key whose only rows are DELETED is NOT cached at all;
 *   - two ENABLED rows for one platform key STILL refuse to start
 *     (the boot invariant is preserved).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppSettingsService } from '../appSettings.service';
import { GlobalSettingFactory, ValueType } from '@arcaai/domains';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const KEY = 'task402.recreated.key';

const buildSetting = (key: string, value: string, deleted = false) => {
  const entity = GlobalSettingFactory.CreateGlobalSetting({
    tenantId: GLOBAL_TENANT_ID,
    key,
    value,
    dataType: ValueType.String,
    defaultValue: '',
    name: key,
    namespace: 'com.flw.test',
    description: '',
    locked: false,
  });
  if (deleted) entity.delete();
  return entity;
};

const repo = { findAll: vi.fn() };
const events = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };
const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

const buildService = () => new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);

describe('AppSettingsService — TASK-402 soft-DELETED rows are invisible to invariant + cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.APP_SETTINGS_BOOT_INVARIANT;
    process.env.NODE_ENV = 'production';
  });

  it('tolerates a DELETED+recreated platform key (DELETED first) and serves the ENABLED row', async () => {
    repo.findAll.mockResolvedValue([buildSetting(KEY, 'old-deleted', true), buildSetting(KEY, 'recreated')]);
    const svc = buildService();

    await expect(svc.cacheAppSettings()).resolves.toBeUndefined();
    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('recreated');
  });

  it('tolerates the pair in the REVERSE ordering — the DELETED row never shadows the ENABLED one', async () => {
    repo.findAll.mockResolvedValue([buildSetting(KEY, 'recreated'), buildSetting(KEY, 'old-deleted', true)]);
    const svc = buildService();

    await expect(svc.cacheAppSettings()).resolves.toBeUndefined();
    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('recreated');
  });

  it('does not cache a key whose only rows are DELETED', async () => {
    repo.findAll.mockResolvedValue([buildSetting(KEY, 'tombstone', true), buildSetting('task402.live.key', 'alive')]);
    const svc = buildService();

    await svc.cacheAppSettings();

    expect(svc.hasSetting(KEY)).toBe(false);
    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('fallback');
    expect(svc.getValueWithDefault('task402.live.key', 'fallback')).toBe('alive');
  });

  it('still refuses to start on a GENUINE duplicate (two ENABLED rows, same platform key)', async () => {
    repo.findAll.mockResolvedValue([buildSetting(KEY, 'a'), buildSetting(KEY, 'b')]);
    const svc = buildService();

    await expect(svc.cacheAppSettings()).rejects.toThrow(/duplicate platform key/i);
  });

  it('two DELETED rows + one ENABLED row for the same key is still fine (repeated delete/recreate cycles)', async () => {
    repo.findAll.mockResolvedValue([
      buildSetting(KEY, 'gen1', true),
      buildSetting(KEY, 'gen2', true),
      buildSetting(KEY, 'gen3'),
    ]);
    const svc = buildService();

    await expect(svc.cacheAppSettings()).resolves.toBeUndefined();
    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('gen3');
  });
});
