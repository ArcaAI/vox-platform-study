import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditRetentionService } from '../audit-retention.service';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = {
    'audit-retention.enabled': true,
    'audit-retention.cron': '0 3 * * *',
    'audit-retention.retention-days': 365,
    'audit-retention.batch-size': 1000,
    'audit-retention.max-batches-per-run': 1000,
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
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  return {
    baseClient: { auditLog: { findMany, deleteMany } },
    _findMany: findMany,
    _deleteMany: deleteMany,
  };
};

const buildService = (
  appSettings: ReturnType<typeof createMockAppSettingsService>,
  schedulerRegistry: ReturnType<typeof createMockSchedulerRegistry>,
  databaseService: ReturnType<typeof createMockDatabaseService>,
) => new AuditRetentionService(appSettings as never, schedulerRegistry as never, databaseService as never);

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

describe('AuditRetentionService', () => {
  let service: AuditRetentionService;
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
      expect(config.cron).toBe('0 3 * * *');
      expect(config.retentionDays).toBe(365);
      expect(config.batchSize).toBe(1000);
      expect(config.maxBatchesPerRun).toBe(1000);
    });

    it('should fall back to defaults when settings are missing', () => {
      mockAppSettings.getValueWithDefault.mockImplementation(<T>(_key: string, defaultValue: T): T => defaultValue);

      const config = service.getConfig();

      expect(config.enabled).toBe(false);
      expect(config.cron).toBe('0 3 * * *');
      expect(config.retentionDays).toBe(365);
      expect(config.batchSize).toBe(1000);
      expect(config.maxBatchesPerRun).toBe(1000);
    });
  });

  describe('isEnabled', () => {
    it('should return true when audit-retention.enabled is true', () => {
      expect(service.isEnabled).toBe(true);
    });

    it('should return false when audit-retention.enabled is false', () => {
      mockAppSettings = createMockAppSettingsService({ 'audit-retention.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);
      expect(service.isEnabled).toBe(false);
    });
  });

  // ─── Dynamic Scheduling ─────────────────────────────────────

  describe('syncSchedulerFromConfig', () => {
    it('should create a cron job when enabled and no job exists', () => {
      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith('audit-log-retention', expect.any(Object));
    });

    it('should not create a job when disabled', () => {
      mockAppSettings = createMockAppSettingsService({ 'audit-retention.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('should stop existing job when disabled after being enabled', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      mockAppSettings.getValueWithDefault.mockImplementation(<T>(key: string, defaultValue: T): T => {
        if (key === 'audit-retention.enabled') return false as T;
        if (key === 'audit-retention.cron') return '0 3 * * *' as T;
        return defaultValue;
      });

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('audit-log-retention');
    });

    it('should replace job when cron expression changes', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      mockAppSettings.getValueWithDefault.mockImplementation(<T>(key: string, defaultValue: T): T => {
        if (key === 'audit-retention.enabled') return true as T;
        if (key === 'audit-retention.cron') return '0 5 * * *' as T;
        return defaultValue;
      });

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('audit-log-retention');
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
    });

    it('should not replace job when config is unchanged', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleInit', () => {
    it('should call syncSchedulerFromConfig', () => {
      service.onModuleInit();

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith('audit-log-retention', expect.any(Object));
    });
  });

  describe('onSettingsRefreshed (event handler)', () => {
    it('should call syncSchedulerFromConfig when settings refresh', () => {
      service.onSettingsRefreshed();

      expect(mockAppSettings.getValueWithDefault).toHaveBeenCalledWith('audit-retention.enabled', expect.any(Boolean));
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop the cron job on shutdown', () => {
      service.syncSchedulerFromConfig();
      service.onModuleDestroy();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('audit-log-retention');
    });
  });

  // ─── handleScheduledPurge ───────────────────────────────────

  describe('handleScheduledPurge', () => {
    it('should skip when disabled', async () => {
      mockAppSettings = createMockAppSettingsService({ 'audit-retention.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      await service.handleScheduledPurge();

      expect(mockDatabaseService._findMany).not.toHaveBeenCalled();
      expect(mockDatabaseService._deleteMany).not.toHaveBeenCalled();
    });

    it('should run purge when enabled', async () => {
      await service.handleScheduledPurge();

      expect(mockDatabaseService._findMany).toHaveBeenCalled();
    });
  });

  // ─── purgeExpired ───────────────────────────────────────────

  describe('purgeExpired', () => {
    it('should query rows older than the retention window via the unscoped base client', async () => {
      vi.useFakeTimers();
      const now = new Date('2026-06-06T00:00:00.000Z');
      vi.setSystemTime(now);

      mockAppSettings = createMockAppSettingsService({ 'audit-retention.retention-days': 30 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      const result = await service.purgeExpired();

      const expectedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      expect(result.cutoff.getTime()).toBe(expectedCutoff.getTime());

      const findArgs = mockDatabaseService._findMany.mock.calls[0][0];
      expect(findArgs.where.createdAt.lt.getTime()).toBe(expectedCutoff.getTime());
      expect(findArgs.select).toEqual({ id: true });
    });

    it('should return zero when nothing is expired', async () => {
      mockDatabaseService._findMany.mockResolvedValue([]);

      const result = await service.purgeExpired();

      expect(result.totalDeleted).toBe(0);
      expect(result.batches).toBe(0);
      expect(mockDatabaseService._deleteMany).not.toHaveBeenCalled();
    });

    it('should delete expired rows by id and report the total', async () => {
      mockAppSettings = createMockAppSettingsService({ 'audit-retention.batch-size': 10 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      mockDatabaseService._findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);
      mockDatabaseService._deleteMany.mockResolvedValueOnce({ count: 2 });

      const result = await service.purgeExpired();

      expect(result.totalDeleted).toBe(2);
      expect(result.batches).toBe(1);
      expect(mockDatabaseService._deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] } },
      });
    });

    it('should loop across multiple full batches until drained', async () => {
      mockAppSettings = createMockAppSettingsService({ 'audit-retention.batch-size': 2 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      mockDatabaseService._findMany.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]).mockResolvedValueOnce([{ id: 'c' }]);
      mockDatabaseService._deleteMany.mockResolvedValueOnce({ count: 2 }).mockResolvedValueOnce({ count: 1 });

      const result = await service.purgeExpired();

      expect(result.totalDeleted).toBe(3);
      expect(result.batches).toBe(2);
      expect(mockDatabaseService._findMany).toHaveBeenCalledTimes(2);
      expect(mockDatabaseService._deleteMany).toHaveBeenCalledTimes(2);
    });

    it('should stop at maxBatchesPerRun to bound a single run', async () => {
      mockAppSettings = createMockAppSettingsService({
        'audit-retention.batch-size': 2,
        'audit-retention.max-batches-per-run': 2,
      });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      mockDatabaseService._findMany.mockResolvedValue([{ id: 'x' }, { id: 'y' }]);
      mockDatabaseService._deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.purgeExpired();

      expect(result.batches).toBe(2);
      expect(mockDatabaseService._findMany).toHaveBeenCalledTimes(2);
      expect(result.totalDeleted).toBe(4);
    });

    it('should refuse to purge with a non-positive retention window (safety guard)', async () => {
      mockAppSettings = createMockAppSettingsService({ 'audit-retention.retention-days': 0 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockDatabaseService);

      const result = await service.purgeExpired();

      expect(result.totalDeleted).toBe(0);
      expect(result.batches).toBe(0);
      expect(mockDatabaseService._findMany).not.toHaveBeenCalled();
      expect(mockDatabaseService._deleteMany).not.toHaveBeenCalled();
    });
  });
});
