import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SysEventType, TranscriptionJobStatus } from '@arcaai/domains';

import { STT_BATCH_DEFAULTS, STT_BATCH_REAPER_CRON_KEY, STT_BATCH_STALE_PROCESSING_MINUTES_KEY } from '../../../../settings-registry/descriptors/stt-gateway.descriptors';
import { SttJobReaperService, STT_JOB_REAPER_ERROR_CODE } from '../stt-job-reaper.service';

/**
 * TASK-992 — the backstop for the case a reclaim cannot reach.
 *
 * Reclaim only fires when the broker REDELIVERS the message. If the message is
 * lost outright, nothing calls `/start` again and the row stays PROCESSING
 * forever — the shape of the two rows found stranded on `hope-v2-dev`, one of
 * them since February. This sweep is the only thing in the platform that ends
 * such a job.
 */

function makeJob(overrides: Partial<{ id: string; tenantId: string; status: string; workerId: string | null; createdBy: string | null }> = {}) {
  let _status = overrides.status ?? TranscriptionJobStatus.PROCESSING;
  const _changes: Record<string, unknown> = {};
  const entity = {
    id: overrides.id ?? 'job-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    createdBy: 'createdBy' in overrides ? overrides.createdBy : 'user-1',
    workerId: 'workerId' in overrides ? overrides.workerId : 'host-a-59400',
    version: 1,
    get status() {
      return _status;
    },
    get errorCode() {
      return _changes.errorCode as string | undefined;
    },
    get errorMessage() {
      return _changes.errorMessage as string | undefined;
    },
    get isTerminal() {
      return (
        _status === TranscriptionJobStatus.COMPLETED ||
        _status === TranscriptionJobStatus.FAILED ||
        _status === TranscriptionJobStatus.CANCELLED ||
        _status === TranscriptionJobStatus.DEAD
      );
    },
    fail(errorMessage: string, errorCode?: string) {
      if (entity.isTerminal) throw new Error(`Cannot fail job in ${_status} status`);
      _status = TranscriptionJobStatus.FAILED;
      _changes.status = _status;
      _changes.errorMessage = errorMessage;
      _changes.errorCode = errorCode;
    },
  };
  return entity;
}

describe('SttJobReaperService', () => {
  let repository: { findStaleProcessingJobs: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let eventEmitter: { emit: ReturnType<typeof vi.fn> };
  let clsService: { run: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let appSettings: { getValueWithDefault: ReturnType<typeof vi.fn> };
  let schedulerRegistry: { addCronJob: ReturnType<typeof vi.fn>; getCronJob: ReturnType<typeof vi.fn>; deleteCronJob: ReturnType<typeof vi.fn> };
  let service: SttJobReaperService;
  let boundTenantIds: string[];

  beforeEach(() => {
    boundTenantIds = [];
    repository = { findStaleProcessingJobs: vi.fn().mockResolvedValue([]), update: vi.fn().mockImplementation(async (_id, e) => e) };
    eventEmitter = { emit: vi.fn() };
    clsService = {
      run: vi.fn(async (cb: () => Promise<void>) => cb()),
      set: vi.fn((key: string, value: unknown) => {
        if (key === 'tenantId') boundTenantIds.push(value as string);
      }),
      get: vi.fn(),
    };
    appSettings = {
      getValueWithDefault: vi.fn((key: string, fallback: unknown) => fallback),
    };
    schedulerRegistry = { addCronJob: vi.fn(), getCronJob: vi.fn(), deleteCronJob: vi.fn() };

    service = new SttJobReaperService(
      repository as never,
      eventEmitter as never,
      clsService as never,
      appSettings as never,
      schedulerRegistry as never,
    );
  });

  describe('configuration', () => {
    it('falls back to the code defaults when no GlobalSetting row exists', () => {
      expect(service.getConfig()).toEqual({
        cron: STT_BATCH_DEFAULTS[STT_BATCH_REAPER_CRON_KEY],
        staleProcessingMinutes: STT_BATCH_DEFAULTS[STT_BATCH_STALE_PROCESSING_MINUTES_KEY],
      });
    });

    it('reads a live override without a redeploy', () => {
      appSettings.getValueWithDefault.mockImplementation((key: string, fallback: unknown) =>
        key === STT_BATCH_STALE_PROCESSING_MINUTES_KEY ? 45 : fallback,
      );

      expect(service.getConfig().staleProcessingMinutes).toBe(45);
    });
  });

  describe('sweepOnce', () => {
    it('queries with a cutoff derived from the configured window', async () => {
      const before = Date.now();

      await service.sweepOnce();

      expect(repository.findStaleProcessingJobs).toHaveBeenCalledTimes(1);
      const cutoff = repository.findStaleProcessingJobs.mock.calls[0][0] as Date;
      const windowMs = STT_BATCH_DEFAULTS[STT_BATCH_STALE_PROCESSING_MINUTES_KEY] * 60_000;
      expect(cutoff.getTime()).toBeLessThanOrEqual(before - windowMs + 1_000);
      expect(cutoff.getTime()).toBeGreaterThan(before - windowMs - 60_000);
    });

    it('fails a stranded job with a cause an operator can act on', async () => {
      const job = makeJob({ id: 'job-stranded', workerId: 'host-a-59400' });
      repository.findStaleProcessingJobs.mockResolvedValue([job]);

      const result = await service.sweepOnce();

      expect(job.status).toBe(TranscriptionJobStatus.FAILED);
      expect(job.errorCode).toBe(STT_JOB_REAPER_ERROR_CODE);
      expect(job.errorMessage).toContain('host-a-59400');
      expect(repository.update).toHaveBeenCalledWith('job-stranded', job);
      expect(result).toEqual({ eligible: 1, reaped: 1, failed: 0 });
    });

    it("binds each row's OWN tenant for the write, so the sys-event is attributed correctly", async () => {
      repository.findStaleProcessingJobs.mockResolvedValue([
        makeJob({ id: 'job-a', tenantId: 'tenant-a' }),
        makeJob({ id: 'job-b', tenantId: 'tenant-b' }),
      ]);

      await service.sweepOnce();

      // The eligibility read is deliberately cross-tenant with no CLS context;
      // binding once for the whole tick would attribute tenant-b's audit row
      // to tenant-a.
      expect(boundTenantIds).toEqual(['tenant-a', 'tenant-b']);
    });

    it('emits ResourceUpdated per reaped row', async () => {
      repository.findStaleProcessingJobs.mockResolvedValue([makeJob({ id: 'job-stranded' })]);

      await service.sweepOnce();

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        SysEventType.ResourceUpdated,
        expect.objectContaining({
          resourceId: 'job-stranded',
          data: expect.objectContaining({ status: TranscriptionJobStatus.FAILED, errorCode: STT_JOB_REAPER_ERROR_CODE }),
        }),
      );
    });

    it('keeps going when one row fails, and counts it', async () => {
      const healthy = makeJob({ id: 'job-ok' });
      // A row that raced into a terminal state between the read and the write.
      const raced = makeJob({ id: 'job-raced', status: TranscriptionJobStatus.COMPLETED });
      repository.findStaleProcessingJobs.mockResolvedValue([raced, healthy]);

      const result = await service.sweepOnce();

      expect(result).toEqual({ eligible: 2, reaped: 1, failed: 1 });
      expect(healthy.status).toBe(TranscriptionJobStatus.FAILED);
    });

    it('refuses a non-positive window rather than reaping every PROCESSING job in one tick', async () => {
      appSettings.getValueWithDefault.mockImplementation((key: string, fallback: unknown) =>
        key === STT_BATCH_STALE_PROCESSING_MINUTES_KEY ? 0 : fallback,
      );

      const result = await service.sweepOnce();

      expect(repository.findStaleProcessingJobs).not.toHaveBeenCalled();
      expect(result).toEqual({ eligible: 0, reaped: 0, failed: 0 });
    });
  });

  describe('scheduling', () => {
    it('registers a cron job on init', () => {
      service.onModuleInit();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
    });

    it('does not re-register when the cron expression is unchanged', () => {
      service.onModuleInit();
      service.onSettingsRefreshed();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(1);
    });

    it('re-schedules when the cron expression changes, with no redeploy', () => {
      service.onModuleInit();
      appSettings.getValueWithDefault.mockImplementation((key: string, fallback: unknown) =>
        key === STT_BATCH_REAPER_CRON_KEY ? '*/2 * * * *' : fallback,
      );

      service.onSettingsRefreshed();

      expect(schedulerRegistry.addCronJob).toHaveBeenCalledTimes(2);
    });
  });
});
