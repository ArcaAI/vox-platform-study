import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentTrajectoryRetentionService } from '../agent-trajectory-retention.service';

// ─── Mock Factories ─────────────────────────────────────────────────

const createMockAppSettingsService = (overrides: Record<string, unknown> = {}) => {
  const settings: Record<string, unknown> = {
    'agentic.trajectory.enabled': true,
    'agentic.trajectory.cron': '0 4 * * *',
    'agentic.trajectory.retentionDays': 30,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

const createMockTrajectoryService = () => ({
  pruneOlderThan: vi.fn().mockResolvedValue(0),
});

const buildService = (
  appSettings: ReturnType<typeof createMockAppSettingsService>,
  schedulerRegistry: ReturnType<typeof createMockSchedulerRegistry>,
  trajectoryService: ReturnType<typeof createMockTrajectoryService>,
) =>
  new AgentTrajectoryRetentionService(
    appSettings as never,
    schedulerRegistry as never,
    trajectoryService as never,
  );

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

describe('AgentTrajectoryRetentionService', () => {
  let service: AgentTrajectoryRetentionService;
  let mockAppSettings: ReturnType<typeof createMockAppSettingsService>;
  let mockSchedulerRegistry: ReturnType<typeof createMockSchedulerRegistry>;
  let mockTrajectoryService: ReturnType<typeof createMockTrajectoryService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAppSettings = createMockAppSettingsService();
    mockSchedulerRegistry = createMockSchedulerRegistry();
    mockTrajectoryService = createMockTrajectoryService();
    service = buildService(mockAppSettings, mockSchedulerRegistry, mockTrajectoryService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getConfig', () => {
    it('should read all settings from AppSettingsService', () => {
      const config = service.getConfig();

      expect(config.enabled).toBe(true);
      expect(config.cron).toBe('0 4 * * *');
      expect(config.retentionDays).toBe(30);
    });

    it('should fall back to defaults when settings are missing', () => {
      mockAppSettings.getValueWithDefault.mockImplementation(
        <T>(_key: string, defaultValue: T): T => defaultValue,
      );

      const config = service.getConfig();

      expect(config.enabled).toBe(false);
      expect(config.cron).toBe('0 4 * * *');
      expect(config.retentionDays).toBe(30);
    });
  });

  describe('isEnabled', () => {
    it('should return true when agentic.trajectory.enabled is true', () => {
      expect(service.isEnabled).toBe(true);
    });

    it('should return false when agentic.trajectory.enabled is false', () => {
      mockAppSettings = createMockAppSettingsService({ 'agentic.trajectory.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockTrajectoryService);
      expect(service.isEnabled).toBe(false);
    });
  });

  describe('syncSchedulerFromConfig', () => {
    it('should create a cron job when enabled and no job exists', () => {
      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'agent-trajectory-retention',
        expect.any(Object),
      );
    });

    it('should not create a job when disabled', () => {
      mockAppSettings = createMockAppSettingsService({ 'agentic.trajectory.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockTrajectoryService);

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.addCronJob).not.toHaveBeenCalled();
    });

    it('should stop existing job when disabled after being enabled', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      mockAppSettings.getValueWithDefault.mockImplementation(
        <T>(key: string, defaultValue: T): T => {
          if (key === 'agentic.trajectory.enabled') return false as T;
          if (key === 'agentic.trajectory.cron') return '0 4 * * *' as T;
          return defaultValue;
        },
      );

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('agent-trajectory-retention');
    });

    it('should replace job when cron expression changes', () => {
      service.syncSchedulerFromConfig();
      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);

      mockAppSettings.getValueWithDefault.mockImplementation(
        <T>(key: string, defaultValue: T): T => {
          if (key === 'agentic.trajectory.enabled') return true as T;
          if (key === 'agentic.trajectory.cron') return '0 5 * * *' as T;
          return defaultValue;
        },
      );

      service.syncSchedulerFromConfig();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('agent-trajectory-retention');
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

      expect(mockSchedulerRegistry.addCronJob).toHaveBeenCalledWith(
        'agent-trajectory-retention',
        expect.any(Object),
      );
    });
  });

  describe('onSettingsRefreshed (event handler)', () => {
    it('should call syncSchedulerFromConfig when settings refresh', () => {
      service.onSettingsRefreshed();

      expect(mockAppSettings.getValueWithDefault).toHaveBeenCalledWith(
        'agentic.trajectory.enabled',
        expect.any(Boolean),
      );
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop the cron job on shutdown', () => {
      service.syncSchedulerFromConfig();
      service.onModuleDestroy();

      expect(mockSchedulerRegistry.deleteCronJob).toHaveBeenCalledWith('agent-trajectory-retention');
    });
  });

  describe('handleScheduledPurge', () => {
    it('should skip when disabled', async () => {
      mockAppSettings = createMockAppSettingsService({ 'agentic.trajectory.enabled': false });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockTrajectoryService);

      await service.handleScheduledPurge();

      expect(mockTrajectoryService.pruneOlderThan).not.toHaveBeenCalled();
    });

    it('should call pruneOlderThan with retentionDays when enabled', async () => {
      mockAppSettings = createMockAppSettingsService({ 'agentic.trajectory.retentionDays': 14 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockTrajectoryService);
      mockTrajectoryService.pruneOlderThan.mockResolvedValue(7);

      await service.handleScheduledPurge();

      expect(mockTrajectoryService.pruneOlderThan).toHaveBeenCalledWith(14);
    });

    it('should refuse to prune with a non-positive retention window', async () => {
      mockAppSettings = createMockAppSettingsService({ 'agentic.trajectory.retentionDays': 0 });
      service = buildService(mockAppSettings, mockSchedulerRegistry, mockTrajectoryService);

      await service.handleScheduledPurge();

      expect(mockTrajectoryService.pruneOlderThan).not.toHaveBeenCalled();
    });
  });
});
