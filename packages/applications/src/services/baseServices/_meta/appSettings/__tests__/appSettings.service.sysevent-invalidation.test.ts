/**
 * F-031-adjacent gap: the AppSettings cache only refreshed on a once-a-minute
 * cron (`'45 * * * * *'` — fires at second :45 of every minute, worst case
 * ~60s, mean ~30s; NOT "every 45 seconds" as the constant's comment claims).
 * A `GlobalSetting` write broadcasts `SysEventType.ResourceUpdated` (every
 * `BaseService.broadcastSysEvent` call does), but nothing subscribed to it to
 * invalidate this service's in-memory snapshot — so a second writer that does
 * not itself call `refreshCache()` (e.g. the legacy `GlobalSettingService`
 * CRUD path, unlike `SettingsRegistryWriteService.write()`) left readers on
 * this instance serving a stale value until the next cron tick.
 *
 * Pins: a `ResourceUpdated` event with `resourceType: GlobalSetting` triggers
 * an immediate cache refresh (write-then-read converges without the cron);
 * an unrelated resourceType is ignored (no needless DB re-read).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppSettingsService } from '../appSettings.service';
import { GlobalSettingFactory, ResourceType, SysEvent, SysEventType, ValueType } from '@arcaai/domains';

const GLOBAL_TENANT_ID = '50000000-0000-0000-0000-000000000000';
const KEY = 'f007.convergence.key';

const buildSetting = (value: string) =>
  GlobalSettingFactory.CreateGlobalSetting({
    tenantId: GLOBAL_TENANT_ID,
    key: KEY,
    value,
    dataType: ValueType.String,
    defaultValue: '',
    name: KEY,
    namespace: 'com.flw.test',
    description: '',
    locked: false,
  });

const repo = { findAll: vi.fn() };
const events = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };
const scheduler = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

const buildService = () => new AppSettingsService(repo as never, events as never, cls as never, scheduler as never);

const buildResourceUpdatedEvent = (resourceType: ResourceType): SysEvent =>
  ({ type: SysEventType.ResourceUpdated, resourceType, tenantId: GLOBAL_TENANT_ID }) as SysEvent;

describe('AppSettingsService — sys-event cache invalidation (F-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('converges write-then-read on a GlobalSetting ResourceUpdated event, without waiting for the cron', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const svc = buildService();
    await svc.cacheAppSettings();
    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('initial');

    // Simulate a second writer's row change (repo now serves the new value)
    // followed by the sys-event that writer broadcasts on every mutation.
    repo.findAll.mockResolvedValue([buildSetting('updated')]);
    repo.findAll.mockClear();
    await svc.handleGlobalSettingUpdated(buildResourceUpdatedEvent(ResourceType.GlobalSetting));

    expect(svc.getValueWithDefault(KEY, 'fallback')).toBe('updated');
    // The handler triggers exactly one fresh DB read.
    expect(repo.findAll).toHaveBeenCalledTimes(1);
  });

  it('ignores a ResourceUpdated event for an unrelated resource type (no needless DB re-read)', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const svc = buildService();
    await svc.cacheAppSettings();
    repo.findAll.mockClear();

    await svc.handleGlobalSettingUpdated(buildResourceUpdatedEvent(ResourceType.Department));

    expect(repo.findAll).not.toHaveBeenCalled();
  });

  it('degrades cleanly (no throw) when the refresh itself fails', async () => {
    repo.findAll.mockResolvedValue([buildSetting('initial')]);
    const svc = buildService();
    await svc.cacheAppSettings();

    repo.findAll.mockRejectedValueOnce(new Error('db unreachable'));

    await expect(svc.handleGlobalSettingUpdated(buildResourceUpdatedEvent(ResourceType.GlobalSetting))).resolves.toBeUndefined();
  });
});
