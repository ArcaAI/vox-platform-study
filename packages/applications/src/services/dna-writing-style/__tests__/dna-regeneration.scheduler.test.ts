import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobQueue } from '@arcaai/domains';
import { DnaRegenerationScheduler } from '../dna-regeneration.scheduler';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockQueryBuilder = () => {
  const mockWhere = vi.fn().mockReturnThis();
  const mockToList = vi.fn().mockResolvedValue([]);
  return { Where: mockWhere, ToList: mockToList };
};

const createMockDnaReportRepository = () => ({
  $: vi.fn(),
});

const createMockQueue = () => ({
  add: vi.fn().mockResolvedValue({ id: 'job-mock' }),
});

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = {
    'dna-regen.enabled': true,
    'dna-regen.cron': '0 0 1 * *',
    'dna-regen.job-delay-ms': 5000,
    'dna-regen.max-samples': 50,
    'dna-regen.max-context-chars': 100000,
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

const createMockReportModel = (overrides: Record<string, unknown> = {}) => ({
  id: overrides.id ?? 'report-1',
  tenantId: overrides.tenantId ?? 'tenant-1',
  doctorId: overrides.doctorId ?? 'doctor-1',
  isLatest: overrides.isLatest ?? true,
  resourceStatus: overrides.resourceStatus ?? 'ENABLED',
});

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    DnaWritingStyleReportEntityMapper: {
      getInstance: () => ({
        toDomainEntity: (model: Record<string, unknown>) => model,
      }),
    },
  };
});

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

describe('DnaRegenerationScheduler', () => {
  let scheduler: DnaRegenerationScheduler;
  let mockAppSettings: ReturnType<typeof createMockAppSettingsService>;
  let mockSchedulerRegistry: ReturnType<typeof createMockSchedulerRegistry>;
  let mockReportRepo: ReturnType<typeof createMockDnaReportRepository>;
  let mockQueue: ReturnType<typeof createMockQueue>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppSettings = createMockAppSettingsService();
    mockSchedulerRegistry = createMockSchedulerRegistry();
    mockReportRepo = createMockDnaReportRepository();
    mockQueue = createMockQueue();

    scheduler = new DnaRegenerationScheduler(mockAppSettings as never, mockSchedulerRegistry as never, mockReportRepo as never, mockQueue as never);
  });

  // ─── Config Reading ─────────────────────────────────────────

  describe('getConfig', () => {
    it('should read all settings from AppSettingsService', () => {
      const config = scheduler.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.cron).toBe('0 0 1 * *');
      expect(config.jobDelayMs).toBe(5000);
    });

    it('should fall back to defaults when settings are missing', () => {
      mockAppSettings = createMockAppSettingsService({
        'dna-regen.enabled': undefined,
        'dna-regen.cron': undefined,
        'dna-regen.job-delay-ms': undefined,
      });
      // Re-create with settings that return undefined so defaults kick in
      mockAppSettings.getValueWithDefault.mockImplementation(<T>(_key: string, defaultValue: T): T => defaultValue);
      scheduler = new DnaRegenerationScheduler(mockAppSettings as never, mockSchedulerRegistry as never, mockReportRepo as never, mockQueue as never);

      const config = scheduler.getConfig();

      expect(config.enabled).toBe(false);
      expect(config.cron).toBe('0 0 1 * *');
      expect(config.jobDelayMs).toBe(5000);
    });
  });

  describe('isEnabled', () => {
    it('should return true when dna-regen.enabled is true', () => {
      expect(scheduler.isEnabled).toBe(true);
    });

    it('should return false when dna-regen.enabled is false', () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-regen.enabled': false });
      scheduler = new DnaRegenerationScheduler(mockAppSettings as never, mockSchedulerRegistry as never, mockReportRepo as never, mockQueue as never);
      expect(scheduler.isEnabled).toBe(false);
    });
  });

  // ─── Dynamic Scheduling ─────────────────────────────────────

  describe('syncSchedulerFromConfig', () => {
    it('should create a cron job when enabled and no job exists', () => {
      scheduler.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith('dna-regeneration', expect.any(Object));
    });

    it('should not create a job when disabled', () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-regen.enabled': false });
      scheduler = new DnaRegenerationScheduler(mockAppSettings as never, mockSchedulerRegistry as never, mockReportRepo as never, mockQueue as never);

      scheduler.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('should stop existing job when disabled after being enabled', () => {
      scheduler.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      // Now disable
      mockAppSettings.getValueWithDefault.mockImplementation(<T>(key: string, defaultValue: T): T => {
        if (key === 'dna-regen.enabled') return false as T;
        if (key === 'dna-regen.cron') return '0 0 1 * *' as T;
        return defaultValue;
      });

      scheduler.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('dna-regeneration');
    });

    it('should replace job when cron expression changes', () => {
      scheduler.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      // Change cron
      mockAppSettings.getValueWithDefault.mockImplementation(<T>(key: string, defaultValue: T): T => {
        if (key === 'dna-regen.enabled') return true as T;
        if (key === 'dna-regen.cron') return '0 3 * * *' as T;
        return defaultValue;
      });

      scheduler.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('dna-regeneration');
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
    });

    it('should not replace job when config is unchanged', () => {
      scheduler.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      scheduler.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
    });
  });

  describe('onModuleInit', () => {
    it('should call syncSchedulerFromConfig', async () => {
      await scheduler.onModuleInit();

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith('dna-regeneration', expect.any(Object));
    });
  });

  describe('onSettingsRefreshed (event handler)', () => {
    it('should call syncSchedulerFromConfig when settings refresh', () => {
      scheduler.onSettingsRefreshed();

      expect(mockAppSettings.getValueWithDefault).toHaveBeenCalledWith('dna-regen.enabled', expect.any(Boolean));
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop the cron job on shutdown', () => {
      scheduler.syncSchedulerFromConfig();
      scheduler.onModuleDestroy();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('dna-regeneration');
    });
  });

  // ─── handleScheduledRegeneration ────────────────────────────

  describe('handleScheduledRegeneration', () => {
    it('should skip when disabled', async () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-regen.enabled': false });
      scheduler = new DnaRegenerationScheduler(mockAppSettings as never, mockSchedulerRegistry as never, mockReportRepo as never, mockQueue as never);

      await scheduler.handleScheduledRegeneration();

      expect(mockReportRepo.$).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('should call regenerateAllDoctors when enabled', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await scheduler.handleScheduledRegeneration();

      expect(mockReportRepo.$).toHaveBeenCalled();
    });
  });

  // ─── regenerateAllDoctors ───────────────────────────────────

  describe('regenerateAllDoctors', () => {
    it('should queue jobs for each unique doctor', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockReportModel({ doctorId: 'doc-1', tenantId: 'tenant-1' }),
        createMockReportModel({ doctorId: 'doc-2', tenantId: 'tenant-1' }),
        createMockReportModel({ doctorId: 'doc-3', tenantId: 'tenant-2' }),
      ]);

      const result = await scheduler.regenerateAllDoctors();

      expect(result.totalDoctors).toBe(3);
      expect(result.jobsQueued).toBe(3);
      expect(result.errors).toHaveLength(0);
      expect(mockQueue.add).toHaveBeenCalledTimes(3);
    });

    it('should deduplicate doctors with multiple reports', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockReportModel({ id: 'r1', doctorId: 'doc-1', tenantId: 'tenant-1' }),
        createMockReportModel({ id: 'r2', doctorId: 'doc-1', tenantId: 'tenant-1' }),
      ]);

      const result = await scheduler.regenerateAllDoctors();

      expect(result.totalDoctors).toBe(1);
      expect(result.jobsQueued).toBe(1);
      expect(mockQueue.add).toHaveBeenCalledTimes(1);
    });

    it('should return zero when no reports exist', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      const result = await scheduler.regenerateAllDoctors();

      expect(result.totalDoctors).toBe(0);
      expect(result.jobsQueued).toBe(0);
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('should include correct payload in queued jobs', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockReportModel({ doctorId: 'doc-1', tenantId: 'tenant-X' })]);

      await scheduler.regenerateAllDoctors();

      const call = mockQueue.add.mock.calls[0];
      expect(call[0]).toBe(JobQueue.GenerateDnaReport);
      const payload = call[1];
      const options = call[2];
      expect(payload.doctorId).toBe('doc-1');
      expect(payload.tenantId).toBe('tenant-X');
      expect(payload.userId).toBe('system-scheduler');
      expect(payload.isRegeneration).toBe(true);
      // L5/F7 — which surface asked. `isRegeneration` is the scheduler's own flag; `origin` is
      // the shared provenance field every DNA enqueue stamps, and the one the report is
      // explainable by.
      expect(payload.origin).toBe('scheduler');
      expect(payload.jobId).toBeDefined();
      expect(options.jobId).toBe(payload.jobId);
    });

    it('should apply job-delay-ms as staggered delay per doctor', async () => {
      mockAppSettings = createMockAppSettingsService({ 'dna-regen.job-delay-ms': 3000 });
      scheduler = new DnaRegenerationScheduler(mockAppSettings as never, mockSchedulerRegistry as never, mockReportRepo as never, mockQueue as never);

      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockReportModel({ doctorId: 'doc-1' }),
        createMockReportModel({ doctorId: 'doc-2' }),
        createMockReportModel({ doctorId: 'doc-3' }),
      ]);

      await scheduler.regenerateAllDoctors();

      expect(mockQueue.add.mock.calls[0][2].delay).toBe(0);
      expect(mockQueue.add.mock.calls[1][2].delay).toBe(3000);
      expect(mockQueue.add.mock.calls[2][2].delay).toBe(6000);
    });

    it('should filter by ENABLED status and isLatest', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([]);

      await scheduler.regenerateAllDoctors();

      expect(mockQb.Where).toHaveBeenCalledWith({ resourceStatus: 'ENABLED' });
      expect(mockQb.Where).toHaveBeenCalledWith({ isLatest: true });
    });

    it('should track errors without stopping other doctors', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockReportModel({ doctorId: 'doc-1', tenantId: 'tenant-1' }),
        createMockReportModel({ doctorId: 'doc-2', tenantId: 'tenant-1' }),
        createMockReportModel({ doctorId: 'doc-3', tenantId: 'tenant-1' }),
      ]);

      mockQueue.add.mockResolvedValueOnce({ id: 'ok-1' }).mockRejectedValueOnce(new Error('Queue full')).mockResolvedValueOnce({ id: 'ok-3' });

      const result = await scheduler.regenerateAllDoctors();

      expect(result.totalDoctors).toBe(3);
      expect(result.jobsQueued).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('doc-2');
      expect(result.errors[0]).toContain('Queue full');
    });

    it('should generate unique jobIds for each doctor', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([createMockReportModel({ doctorId: 'doc-1' }), createMockReportModel({ doctorId: 'doc-2' })]);

      await scheduler.regenerateAllDoctors();

      const jobId1 = mockQueue.add.mock.calls[0][1].jobId;
      const jobId2 = mockQueue.add.mock.calls[1][1].jobId;
      expect(jobId1).not.toBe(jobId2);
    });

    it('should preserve tenant context per doctor', async () => {
      const mockQb = createMockQueryBuilder();
      mockReportRepo.$.mockReturnValue(mockQb);
      mockQb.ToList.mockResolvedValue([
        createMockReportModel({ doctorId: 'doc-A', tenantId: 'tenant-A' }),
        createMockReportModel({ doctorId: 'doc-B', tenantId: 'tenant-B' }),
      ]);

      await scheduler.regenerateAllDoctors();

      expect(mockQueue.add.mock.calls[0][1].tenantId).toBe('tenant-A');
      expect(mockQueue.add.mock.calls[1][1].tenantId).toBe('tenant-B');
    });
  });
});
