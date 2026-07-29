import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchedulerAdminService } from '../scheduler-admin.service';

const createMockCronJob = (
  overrides: Partial<{
    running: boolean;
    lastDate: Date | null;
    nextDate: Date | null;
  }> = {},
) => ({
  isActive: overrides.running ?? true,
  lastDate: vi.fn().mockReturnValue(overrides.lastDate ?? null),
  nextDate: vi.fn().mockReturnValue(overrides.nextDate ?? null),
  stop: vi.fn(),
  start: vi.fn(),
  cronTime: { source: '*/5 * * * *', zone: 'UTC' },
});

const mockSchedulerRegistry = {
  getCronJobs: vi.fn().mockReturnValue(new Map()),
  getCronJob: vi.fn(),
  getIntervals: vi.fn().mockReturnValue([]),
  getTimeouts: vi.fn().mockReturnValue([]),
};

const mockAppSettingsService = {
  getFromCache: vi.fn().mockReturnValue(undefined),
  getValueFromCache: vi.fn(),
  refreshCache: vi.fn().mockResolvedValue(undefined),
};

const mockGlobalSettingService = {
  fetchAll: vi.fn(),
  update: vi.fn(),
};

describe('SchedulerAdminService', () => {
  let service: SchedulerAdminService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSchedulerRegistry.getCronJobs.mockReturnValue(new Map());
    mockSchedulerRegistry.getIntervals.mockReturnValue([]);
    mockSchedulerRegistry.getTimeouts.mockReturnValue([]);
    service = new SchedulerAdminService(mockSchedulerRegistry as any, mockAppSettingsService as any);
  });

  describe('listSchedulers', () => {
    it('should return empty array when no schedulers exist', () => {
      const result = service.listSchedulers();
      expect(result).toEqual([]);
    });

    it('should list cron jobs with correct metadata', () => {
      const luxonLikeDate = { toISO: () => '2026-03-29T10:05:00.000+00:00' };
      const mockJob = createMockCronJob({
        running: true,
        lastDate: new Date('2026-03-29T10:00:00Z'),
        nextDate: luxonLikeDate as any,
      });

      mockSchedulerRegistry.getCronJobs.mockReturnValue(new Map([['test-scheduler', mockJob]]));

      const result = service.listSchedulers();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'test-scheduler',
        type: 'cron',
        source: 'static',
        cronExpression: '*/5 * * * *',
        intervalMs: null,
        running: true,
        lastExecution: '2026-03-29T10:00:00.000Z',
        nextExecution: '2026-03-29T10:05:00.000+00:00',
        timeZone: 'UTC',
        settingsKey: null,
      });
    });

    it('should identify dynamic schedulers (dna-regeneration)', () => {
      const mockJob = createMockCronJob();
      mockSchedulerRegistry.getCronJobs.mockReturnValue(new Map([['dna-regeneration', mockJob]]));

      const result = service.listSchedulers();

      expect(result[0].source).toBe('dynamic');
      expect(result[0].settingsKey).toBe('dna-regen.cron');
    });

    it('should list interval schedulers', () => {
      mockSchedulerRegistry.getIntervals.mockReturnValue(['health-check-interval']);

      const result = service.listSchedulers();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'health-check-interval',
        type: 'interval',
        source: 'static',
        cronExpression: null,
        intervalMs: null,
        running: true,
        lastExecution: null,
        nextExecution: null,
        timeZone: null,
        settingsKey: null,
      });
    });

    it('should list timeout schedulers', () => {
      mockSchedulerRegistry.getTimeouts.mockReturnValue(['one-time-task']);

      const result = service.listSchedulers();

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('timeout');
      expect(result[0].name).toBe('one-time-task');
    });

    it('should combine cron, interval, and timeout schedulers', () => {
      const mockJob = createMockCronJob();
      mockSchedulerRegistry.getCronJobs.mockReturnValue(new Map([['cron-task', mockJob]]));
      mockSchedulerRegistry.getIntervals.mockReturnValue(['interval-task']);
      mockSchedulerRegistry.getTimeouts.mockReturnValue(['timeout-task']);

      const result = service.listSchedulers();

      expect(result).toHaveLength(3);
      expect(result.map((s) => s.type)).toEqual(['cron', 'interval', 'timeout']);
    });
  });

  describe('pauseScheduler', () => {
    it('should stop a running cron job', () => {
      const mockJob = createMockCronJob({ running: true });
      mockSchedulerRegistry.getCronJob.mockReturnValue(mockJob);

      service.pauseScheduler('test-scheduler');

      expect(mockJob.stop).toHaveBeenCalledOnce();
    });

    it('should throw ConflictException when already paused', () => {
      const mockJob = createMockCronJob({ running: false });
      mockSchedulerRegistry.getCronJob.mockReturnValue(mockJob);

      expect(() => service.pauseScheduler('test-scheduler')).toThrow(/already paused/);
    });

    it('should throw NotFoundException when scheduler does not exist', () => {
      mockSchedulerRegistry.getCronJob.mockImplementation(() => {
        throw new Error('No cron job');
      });

      expect(() => service.pauseScheduler('nonexistent')).toThrow();
    });
  });

  describe('resumeScheduler', () => {
    it('should start a paused cron job', () => {
      const mockJob = createMockCronJob({ running: false });
      mockSchedulerRegistry.getCronJob.mockReturnValue(mockJob);

      service.resumeScheduler('test-scheduler');

      expect(mockJob.start).toHaveBeenCalledOnce();
    });

    it('should throw ConflictException when already running', () => {
      const mockJob = createMockCronJob({ running: true });
      mockSchedulerRegistry.getCronJob.mockReturnValue(mockJob);

      expect(() => service.resumeScheduler('test-scheduler')).toThrow(/already running/);
    });
  });

  describe('updateSchedulerCron', () => {
    it('should reject updates to static schedulers', async () => {
      await expect(service.updateSchedulerCron('static-scheduler', '*/10 * * * *')).rejects.toThrow(/static/);
    });

    it('should reject invalid cron expressions', async () => {
      await expect(service.updateSchedulerCron('dna-regeneration', 'invalid-cron')).rejects.toThrow(/Invalid cron/);
    });

    it('should update cron via app settings and refresh cache for dynamic schedulers', async () => {
      const mockJob = createMockCronJob();
      mockSchedulerRegistry.getCronJobs.mockReturnValue(new Map([['dna-regeneration', mockJob]]));

      await service.updateSchedulerCron('dna-regeneration', '0 2 * * *');

      expect(mockAppSettingsService.refreshCache).toHaveBeenCalled();
    });
  });

  describe('toggleScheduler', () => {
    it('should reject toggles on static schedulers', async () => {
      await expect(service.toggleScheduler('static-scheduler', false)).rejects.toThrow(/static/);
    });

    it('should toggle a dynamic scheduler and refresh cache', async () => {
      const mockJob = createMockCronJob();
      mockSchedulerRegistry.getCronJobs.mockReturnValue(new Map([['dna-regeneration', mockJob]]));

      await service.toggleScheduler('dna-regeneration', false);

      expect(mockAppSettingsService.refreshCache).toHaveBeenCalled();
    });
  });
});
