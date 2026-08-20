import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DnaProfileRetentionService } from '../dna-profile-retention.service';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = {
    'dna-profile-retention.enabled': true,
    'dna-profile-retention.cron': '45 3 * * *',
    'dna-profile-retention.retention-days': 30,
    'dna-profile-retention.batch-size': 200,
    'dna-profile-retention.max-batches-per-run': 100,
    ...overrides,
  };
  return {
    getValueWithDefault: vi.fn(<T>(key: string, defaultValue: T): T => {
      return key in settings ? (settings[key] as T) : defaultValue;
    }),
    getValueFromCache: vi.fn((key: string) => settings[key] ?? null),
  };
};

const createMockSchedulerRegistry = () => {
  const registeredJobs = new Map<string, { stop: ReturnType<typeof vi.fn> }>();
  return {
    addCronJob: vi.fn((name: string, job: any) => {
      registeredJobs.set(name, job);
    }),
    deleteCronJob: vi.fn((name: string) => {
      registeredJobs.delete(name);
    }),
    getCronJob: vi.fn((name: string) => {
      if (!registeredJobs.has(name)) throw new Error(`No job named "${name}"`);
      return registeredJobs.get(name);
    }),
    _registeredJobs: registeredJobs,
  };
};

const createMockDatabaseService = () => {
  const findMany = vi.fn().mockResolvedValue([]);
  const reportDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const versionDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  return {
    baseClient: {
      dnaWritingStyleReport: { findMany, deleteMany: reportDeleteMany },
      dnaWritingStyleVersion: { deleteMany: versionDeleteMany },
    },
    _findMany: findMany,
    _reportDeleteMany: reportDeleteMany,
    _versionDeleteMany: versionDeleteMany,
  };
};

const buildService = (
  appSettings: ReturnType<typeof createMockAppSettingsService>,
  schedulerRegistry: ReturnType<typeof createMockSchedulerRegistry>,
  databaseService: ReturnType<typeof createMockDatabaseService>,
) => new DnaProfileRetentionService(appSettings as never, schedulerRegistry as never, databaseService as never);

vi.mock('cron', () => {
  return {
    CronJob: class MockCronJob {
      _callback: () => void;
      start = vi.fn();
      stop = vi.fn();
      constructor(_cron: string, callback: () => void) {
        this._callback = callback;
      }
    },
  };
});

// ─── Tests ──────────────────────────────────────────────────────────

describe('DnaProfileRetentionService', () => {
  let service: DnaProfileRetentionService;
  let mockAppSettings: ReturnType<typeof createMockAppSettingsService>;
  let mockSchedulerRegistry: ReturnType<typeof createMockSchedulerRegistry>;
  let mockDatabaseService: ReturnType<typeof createMockDatabaseService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppSettings = createMockAppSettingsService();
    mockSchedulerRegistry = createMockSchedulerRegistry();
    mockDatabaseService = createMockDatabaseService();
    service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Config Reading ─────────────────────────────────────────

  describe('getConfig', () => {
    it('should read all settings from AppSettingsService', () => {
      const config = service.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.cron).toBe('45 3 * * *');
      expect(config.retentionDays).toBe(30);
      expect(config.batchSize).toBe(200);
      expect(config.maxBatchesPerRun).toBe(100);
    });

    it('should fall back to defaults when settings are missing', () => {
      mockAppSettings.getValueWithDefault.mockImplementation(<T>(_key: string, defaultValue: T): T => defaultValue);

      const config = service.getConfig();

      expect(config.enabled).toBe(false);
      expect(config.cron).toBe('45 3 * * *');
      expect(config.retentionDays).toBe(30);
      expect(config.batchSize).toBe(200);
      expect(config.maxBatchesPerRun).toBe(100);
    });
  });

  describe('isEnabled', () => {
    it('should return true when dna-profile-retention.enabled is true', () => {
      expect(service.isEnabled).toBe(true);
    });

    it('should return false when dna-profile-retention.enabled is false (the shipped default)', () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-profile-retention.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);
      expect(service.isEnabled).toBe(false);
    });
  });

  // ─── Dynamic Scheduling ─────────────────────────────────────

  describe('syncSchedulerFromConfig', () => {
    it('should create a cron job when enabled and no job exists', () => {
      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith('dna-profile-retention', expect.any(Object));
    });

    it('should not create a job when disabled', () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-profile-retention.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('should stop the existing job when disabled after being enabled', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      mockAppSettings.getValueWithDefault.mockImplementation(<T>(key: string, defaultValue: T): T => {
        if (key === 'dna-profile-retention.enabled') return false as T;
        if (key === 'dna-profile-retention.cron') return '45 3 * * *' as T;
        return defaultValue;
      });

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('dna-profile-retention');
    });

    it('should replace the job when the cron expression changes', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      mockAppSettings.getValueWithDefault.mockImplementation(<T>(key: string, defaultValue: T): T => {
        if (key === 'dna-profile-retention.enabled') return true as T;
        if (key === 'dna-profile-retention.cron') return '0 5 * * *' as T;
        return defaultValue;
      });

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('dna-profile-retention');
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
    });

    it('should not replace the job when config is unchanged', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleInit', () => {
    it('should call syncSchedulerFromConfig', () => {
      service.onModuleInit();

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith('dna-profile-retention', expect.any(Object));
    });
  });

  describe('onSettingsRefreshed (event handler)', () => {
    it('should call syncSchedulerFromConfig when settings refresh', () => {
      service.onSettingsRefreshed();

      expect(mockAppSettings.getValueWithDefault).toHaveBeenCalledWith('dna-profile-retention.enabled', expect.any(Boolean));
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop the cron job on shutdown', () => {
      service.syncSchedulerFromConfig();
      service.onModuleDestroy();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('dna-profile-retention');
    });
  });

  // ─── handleScheduledPurge ───────────────────────────────────

  describe('handleScheduledPurge', () => {
    it('should skip when disabled (the shipped default)', async () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-profile-retention.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      await service.handleScheduledPurge();

      expect(mockDatabaseService._findMany).not.toHaveBeenCalled();
      expect(mockDatabaseService._reportDeleteMany).not.toHaveBeenCalled();
      expect(mockDatabaseService._versionDeleteMany).not.toHaveBeenCalled();
    });

    it('should run the purge when enabled', async () => {
      await service.handleScheduledPurge();

      expect(mockDatabaseService._findMany).toHaveBeenCalled();
    });
  });

  // ─── purgeExpired ───────────────────────────────────────────

  describe('purgeExpired', () => {
    it('should query for SOFT-DELETED reports whose resourceStatusUpdatedAt is older than the retention window, via the unscoped base client', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-06-06T00:00:00.000Z');
      vi.setSystemTime(now);

      mockAppSettings = createMockAppSettingsService({ 'dna-profile-retention.retention-days': 30 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      const result = await service.purgeExpired();

      const expectedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      expect(result.cutoff.getTime()).toBe(expectedCutoff.getTime());

      const findArgs = mockDatabaseService._findMany.mock.calls[0][0];
      expect(findArgs.where.resourceStatus).toBe('DELETED');
      expect(findArgs.where.resourceStatusUpdatedAt.lt.getTime()).toBe(expectedCutoff.getTime());
      expect(findArgs.select).toEqual({ id: true });
    });

    it('should return zero when nothing is expired', async () => {
      mockDatabaseService._findMany.mockResolvedValue([]);

      const result = await service.purgeExpired();

      expect(result.totalReportsDeleted).toBe(0);
      expect(result.totalVersionsDeleted).toBe(0);
      expect(result.batches).toBe(0);
      expect(mockDatabaseService._reportDeleteMany).not.toHaveBeenCalled();
      expect(mockDatabaseService._versionDeleteMany).not.toHaveBeenCalled();
    });

    it('hard-deletes a batch of expired reports AND their versions together, and reports both counts', async () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-profile-retention.batch-size': 10 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      mockDatabaseService._findMany.mockResolvedValueOnce([{ id: 'report-a' }, { id: 'report-b' }]);
      mockDatabaseService._versionDeleteMany.mockResolvedValueOnce({ count: 5 });
      mockDatabaseService._reportDeleteMany.mockResolvedValueOnce({ count: 2 });

      const result = await service.purgeExpired();

      expect(result.totalReportsDeleted).toBe(2);
      expect(result.totalVersionsDeleted).toBe(5);
      expect(result.batches).toBe(1);

      // Versions for the batch are deleted BEFORE their parent reports, so an
      // interrupted run never leaves an orphaned version row pointing at an
      // already-purged report.
      const versionCallOrder = mockDatabaseService._versionDeleteMany.mock.invocationCallOrder[0];
      const reportCallOrder = mockDatabaseService._reportDeleteMany.mock.invocationCallOrder[0];
      expect(versionCallOrder).toBeLessThan(reportCallOrder);

      expect(mockDatabaseService._versionDeleteMany).toHaveBeenCalledWith({
        where: { dnaReportId: { in: ['report-a', 'report-b'] } },
      });
      expect(mockDatabaseService._reportDeleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['report-a', 'report-b'] } },
      });
    });

    it('should loop across multiple full batches until drained', async () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-profile-retention.batch-size': 2 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      mockDatabaseService._findMany
        .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
        .mockResolvedValueOnce([{ id: 'c' }]);
      mockDatabaseService._reportDeleteMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });
      mockDatabaseService._versionDeleteMany.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 0 });

      const result = await service.purgeExpired();

      expect(result.totalReportsDeleted).toBe(3);
      expect(result.totalVersionsDeleted).toBe(3);
      expect(result.batches).toBe(2);
      expect(mockDatabaseService._findMany).toHaveBeenCalledTimes(2);
    });

    it('should stop at maxBatchesPerRun to bound a single run', async () => {
      mockAppSettings = createMockAppSettingsService({
        'dna-profile-retention.batch-size': 2,
        'dna-profile-retention.max-batches-per-run': 2,
      });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      mockDatabaseService._findMany.mockResolvedValue([{ id: 'x' }, { id: 'y' }]);
      mockDatabaseService._reportDeleteMany.mockResolvedValue({ count: 2 });
      mockDatabaseService._versionDeleteMany.mockResolvedValue({ count: 0 });

      const result = await service.purgeExpired();

      expect(result.batches).toBe(2);
      expect(mockDatabaseService._findMany).toHaveBeenCalledTimes(2);
      expect(result.totalReportsDeleted).toBe(4);
    });

    it('should refuse to purge with a non-positive retention window (safety guard)', async () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-profile-retention.retention-days': 0 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      const result = await service.purgeExpired();

      expect(result.totalReportsDeleted).toBe(0);
      expect(result.totalVersionsDeleted).toBe(0);
      expect(result.batches).toBe(0);
      expect(mockDatabaseService._findMany).not.toHaveBeenCalled();
    });
  });
});
