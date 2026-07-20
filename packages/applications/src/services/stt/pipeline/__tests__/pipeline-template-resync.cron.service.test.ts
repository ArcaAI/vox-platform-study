/**
 * TASK-531 (GAP-T3) — nightly template-resync scheduler.
 *
 * Mirrors the `AgentTrajectoryRetentionService` precedent: self-scheduling via
 * SchedulerRegistry, configured from AppSettings, re-synced on the settings
 * cache-refresh event.
 *
 * The defining property here is that it is OFF by default. This job mutates
 * TENANT data with no human in the loop, so an operator must opt in explicitly;
 * the admin-triggered endpoint is the primary path. These tests pin that
 * default, because a regression to `enabled: true` would silently start
 * rewriting customer pipeline configs on a timer.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PipelineTemplateResyncCronService } from '../pipeline-template-resync.cron.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = { ...overrides };
  return {
    getValueWithDefault: vi.fn(<T>(key: string, defaultValue: T): T =>
      key in settings ? (settings[key] as T) : defaultValue,
    ),
    getValueFromCache: vi.fn((key: string) => settings[key] ?? null),
  };
};

const createMockSchedulerRegistry = () => {
  const registeredJobs = new Map<string, { stop: ReturnType<typeof vi.fn> }>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    addCronJob: vi.fn((name: string, job: any) => { registeredJobs.set(name, job); }),
    deleteCronJob: vi.fn((name: string) => { registeredJobs.delete(name); }),
    getCronJob: vi.fn((name: string) => {
      if (!registeredJobs.has(name)) throw new Error(`No job named "${name}"`);
      return registeredJobs.get(name);
    }),
    _registeredJobs: registeredJobs,
  };
};

vi.mock('cron', () => ({
  CronJob: class {
    constructor(public cronTime: string, public onTick: () => void) {}
    start = vi.fn();
    stop = vi.fn();
  },
}));

const createMockResyncService = () => ({
  resyncTenant: vi.fn().mockResolvedValue({ added: 0, fastForwarded: 0, skipped: 0 }),
});

const createMockTenantRepository = (tenants: { id: string }[] = []) => ({
  findAll: vi.fn().mockResolvedValue(tenants),
});

const build = (
  appSettings: ReturnType<typeof createMockAppSettingsService>,
  scheduler: ReturnType<typeof createMockSchedulerRegistry>,
  resync: ReturnType<typeof createMockResyncService>,
  tenants: ReturnType<typeof createMockTenantRepository>,
) =>
  new PipelineTemplateResyncCronService(
    appSettings as never,
    scheduler as never,
    resync as never,
    tenants as never,
  );

describe('PipelineTemplateResyncCronService', () => {
  let appSettings: ReturnType<typeof createMockAppSettingsService>;
  let scheduler: ReturnType<typeof createMockSchedulerRegistry>;
  let resync: ReturnType<typeof createMockResyncService>;
  let tenants: ReturnType<typeof createMockTenantRepository>;

  beforeEach(() => {
    vi.clearAllMocks();
    appSettings = createMockAppSettingsService();
    scheduler = createMockSchedulerRegistry();
    resync = createMockResyncService();
    tenants = createMockTenantRepository([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
  });

  it('is DISABLED by default — no job is scheduled', () => {
    const service = build(appSettings, scheduler, resync, tenants);
    service.onModuleInit();

    expect(service.isEnabled).toBe(false);
    expect(scheduler.addCronJob).not.toHaveBeenCalled();
  });

  it('defaults to 03:00 daily when enabled without an explicit cron', () => {
    appSettings = createMockAppSettingsService({ 'pipeline.templateResync.enabled': true });
    const service = build(appSettings, scheduler, resync, tenants);
    service.onModuleInit();

    expect(service.getConfig().cron).toBe('0 3 * * *');
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
  });

  it('reschedules when the settings cache refreshes', () => {
    appSettings = createMockAppSettingsService({ 'pipeline.templateResync.enabled': true });
    const service = build(appSettings, scheduler, resync, tenants);
    service.onModuleInit();
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);

    appSettings.getValueWithDefault.mockImplementation(<T>(key: string, dflt: T): T => {
      if (key === 'pipeline.templateResync.enabled') return true as T;
      if (key === 'pipeline.templateResync.cron') return '30 2 * * *' as T;
      return dflt;
    });
    service.onSettingsRefreshed();

    expect(scheduler.addCronJob).toHaveBeenCalledTimes(2);
    expect(service.getConfig().cron).toBe('30 2 * * *');
  });

  it('stops the job when it is disabled via settings', () => {
    appSettings = createMockAppSettingsService({ 'pipeline.templateResync.enabled': true });
    const service = build(appSettings, scheduler, resync, tenants);
    service.onModuleInit();

    appSettings.getValueWithDefault.mockImplementation(<T>(_key: string, dflt: T): T => dflt);
    service.onSettingsRefreshed();

    expect(scheduler.deleteCronJob).toHaveBeenCalled();
  });

  it('a tick while disabled resyncs nothing', async () => {
    const service = build(appSettings, scheduler, resync, tenants);
    await service.handleScheduledResync();
    expect(resync.resyncTenant).not.toHaveBeenCalled();
  });

  it('resyncs every non-SYSTEM tenant on a tick', async () => {
    appSettings = createMockAppSettingsService({ 'pipeline.templateResync.enabled': true });
    tenants = createMockTenantRepository([
      { id: SYSTEM_TENANT_ID },
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);
    const service = build(appSettings, scheduler, resync, tenants);

    await service.handleScheduledResync();

    expect(resync.resyncTenant).toHaveBeenCalledTimes(2);
    expect(resync.resyncTenant).toHaveBeenCalledWith('tenant-a');
    expect(resync.resyncTenant).toHaveBeenCalledWith('tenant-b');
    expect(resync.resyncTenant).not.toHaveBeenCalledWith(SYSTEM_TENANT_ID);
  });

  it('isolates a per-tenant failure so the sweep continues', async () => {
    appSettings = createMockAppSettingsService({ 'pipeline.templateResync.enabled': true });
    const service = build(appSettings, scheduler, resync, tenants);
    resync.resyncTenant
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ added: 1, fastForwarded: 0, skipped: 0 });

    await expect(service.handleScheduledResync()).resolves.toBeUndefined();
    expect(resync.resyncTenant).toHaveBeenCalledTimes(2);
  });
});
