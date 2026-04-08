import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobAdminService } from '../job-admin.service';
import { JobQueue } from '@arcaai/domains';

const createMockJob = (overrides: Partial<{
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  progress: number;
  attemptsMade: number;
  delay: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string;
  returnvalue: unknown;
  stacktrace: string[];
  parentKey: string | null;
}> = {}) => ({
  id: overrides.id ?? 'job-1',
  name: overrides.name ?? 'default',
  data: overrides.data ?? { key: 'value' },
  opts: {
    attempts: 3,
    delay: 0,
    backoff: null,
    priority: 0,
    removeOnComplete: true,
    removeOnFail: false,
    ...overrides.opts,
  },
  progress: overrides.progress ?? 0,
  attemptsMade: overrides.attemptsMade ?? 0,
  delay: overrides.delay ?? 0,
  timestamp: overrides.timestamp ?? 1711800000000,
  processedOn: overrides.processedOn ?? null,
  finishedOn: overrides.finishedOn ?? null,
  failedReason: overrides.failedReason ?? '',
  returnvalue: overrides.returnvalue ?? null,
  stacktrace: overrides.stacktrace ?? [],
  parentKey: overrides.parentKey ?? null,
  getState: vi.fn().mockResolvedValue('completed'),
  retry: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
  promote: vi.fn().mockResolvedValue(undefined),
  log: vi.fn().mockResolvedValue(undefined),
  logs: undefined as any,
});

const createMockQueue = () => ({
  name: 'TestQueue',
  getJobs: vi.fn().mockResolvedValue([]),
  getJob: vi.fn().mockResolvedValue(null),
  getJobCountByTypes: vi.fn().mockResolvedValue(0),
});

const mockModuleRef = {
  get: vi.fn(),
};

const mockRedactorService = {
  redact: vi.fn().mockImplementation((data: Record<string, unknown>) => data),
};

describe('JobAdminService', () => {
  let service: JobAdminService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new JobAdminService(
      mockModuleRef as any,
      mockRedactorService as any,
    );
  });

  describe('listJobs', () => {
    it('should return paginated job summaries', async () => {
      const mockJob = createMockJob({ id: 'job-1', name: 'SendEmail' });
      const mockQueue = createMockQueue();
      mockQueue.getJobs.mockResolvedValue([mockJob]);
      mockQueue.getJobCountByTypes.mockResolvedValue(1);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.listJobs(JobQueue.SendEmail, {
        page: 0,
        limit: 20,
      });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'job-1',
          name: 'SendEmail',
          queueName: JobQueue.SendEmail,
        }),
      );
    });

    it('should filter by status when provided', async () => {
      const mockQueue = createMockQueue();
      mockQueue.getJobs.mockResolvedValue([]);
      mockQueue.getJobCountByTypes.mockResolvedValue(0);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.listJobs(JobQueue.AuditLog, {
        page: 0,
        limit: 20,
        status: 'failed',
      });

      expect(mockQueue.getJobs).toHaveBeenCalledWith(
        ['failed'],
        0,
        19,
        true,
      );
    });

    it('should get all statuses when status is not specified', async () => {
      const mockQueue = createMockQueue();
      mockQueue.getJobs.mockResolvedValue([]);
      mockQueue.getJobCountByTypes.mockResolvedValue(0);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.listJobs(JobQueue.AuditLog, { page: 0, limit: 20 });

      expect(mockQueue.getJobs).toHaveBeenCalledWith(
        ['waiting', 'active', 'completed', 'failed', 'delayed'],
        0,
        19,
        true,
      );
    });

    it('should calculate correct pagination offsets', async () => {
      const mockQueue = createMockQueue();
      mockQueue.getJobs.mockResolvedValue([]);
      mockQueue.getJobCountByTypes.mockResolvedValue(0);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.listJobs(JobQueue.AuditLog, { page: 2, limit: 10 });

      expect(mockQueue.getJobs).toHaveBeenCalledWith(
        expect.any(Array),
        20,
        29,
        true,
      );
    });

    it('should not include job data in list view', async () => {
      const mockJob = createMockJob({ data: { password: 'secret' } });
      const mockQueue = createMockQueue();
      mockQueue.getJobs.mockResolvedValue([mockJob]);
      mockQueue.getJobCountByTypes.mockResolvedValue(1);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.listJobs(JobQueue.AuditLog, {
        page: 0,
        limit: 20,
      });

      expect(result.items[0]).not.toHaveProperty('data');
    });
  });

  describe('getJobDetail', () => {
    it('should return full job detail with redacted data', async () => {
      const mockJob = createMockJob({
        id: 'job-42',
        name: 'ProcessEmail',
        data: { body: 'Hello patient', fromEmailAddressId: 'addr-1' },
      });
      mockJob.getState.mockResolvedValue('completed');

      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockModuleRef.get.mockReturnValue(mockQueue);

      mockRedactorService.redact.mockReturnValue({
        body: '[REDACTED]',
        fromEmailAddressId: 'addr-1',
      });

      const result = await service.getJobDetail(
        JobQueue.SendEmail,
        'job-42',
      );

      expect(result).toEqual(
        expect.objectContaining({
          id: 'job-42',
          name: 'ProcessEmail',
          queueName: JobQueue.SendEmail,
          status: 'completed',
          data: { body: '[REDACTED]', fromEmailAddressId: 'addr-1' },
        }),
      );
      expect(mockRedactorService.redact).toHaveBeenCalledWith(
        { body: 'Hello patient', fromEmailAddressId: 'addr-1' },
        JobQueue.SendEmail,
        'detail',
      );
    });

    it('should throw NotFoundException when job does not exist', async () => {
      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(null);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await expect(
        service.getJobDetail(JobQueue.AuditLog, 'nonexistent'),
      ).rejects.toThrow();
    });

    it('should include stacktrace and return value', async () => {
      const mockJob = createMockJob({
        stacktrace: ['Error: Something failed', '  at handler (file.ts:10)'],
        returnvalue: { result: 'ok' },
      });
      mockJob.getState.mockResolvedValue('failed');

      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getJobDetail(
        JobQueue.AuditLog,
        'job-1',
      );

      expect(result.stacktrace).toEqual([
        'Error: Something failed',
        '  at handler (file.ts:10)',
      ]);
      expect(result.returnValue).toEqual({ result: 'ok' });
    });
  });

  describe('retryJob', () => {
    it('should call job.retry()', async () => {
      const mockJob = createMockJob();
      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.retryJob(JobQueue.AuditLog, 'job-1');

      expect(mockJob.retry).toHaveBeenCalledOnce();
    });

    it('should throw when job does not exist', async () => {
      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(null);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await expect(
        service.retryJob(JobQueue.AuditLog, 'nonexistent'),
      ).rejects.toThrow();
    });
  });

  describe('removeJob', () => {
    it('should call job.remove()', async () => {
      const mockJob = createMockJob();
      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.removeJob(JobQueue.AuditLog, 'job-1');

      expect(mockJob.remove).toHaveBeenCalledOnce();
    });

    it('should throw when job does not exist', async () => {
      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(null);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await expect(
        service.removeJob(JobQueue.AuditLog, 'nonexistent'),
      ).rejects.toThrow();
    });
  });

  describe('promoteJob', () => {
    it('should call job.promote()', async () => {
      const mockJob = createMockJob();
      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.promoteJob(JobQueue.AuditLog, 'job-1');

      expect(mockJob.promote).toHaveBeenCalledOnce();
    });
  });

  describe('bulkAction', () => {
    it('should retry multiple jobs', async () => {
      const mockJob1 = createMockJob({ id: 'job-1' });
      const mockJob2 = createMockJob({ id: 'job-2' });
      const mockQueue = createMockQueue();
      mockQueue.getJob
        .mockResolvedValueOnce(mockJob1)
        .mockResolvedValueOnce(mockJob2);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.bulkAction(
        JobQueue.AuditLog,
        'retry',
        ['job-1', 'job-2'],
      );

      expect(mockJob1.retry).toHaveBeenCalledOnce();
      expect(mockJob2.retry).toHaveBeenCalledOnce();
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
    });

    it('should remove multiple jobs', async () => {
      const mockJob1 = createMockJob({ id: 'job-1' });
      const mockJob2 = createMockJob({ id: 'job-2' });
      const mockQueue = createMockQueue();
      mockQueue.getJob
        .mockResolvedValueOnce(mockJob1)
        .mockResolvedValueOnce(mockJob2);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.bulkAction(
        JobQueue.AuditLog,
        'remove',
        ['job-1', 'job-2'],
      );

      expect(mockJob1.remove).toHaveBeenCalledOnce();
      expect(mockJob2.remove).toHaveBeenCalledOnce();
      expect(result.succeeded).toBe(2);
    });

    it('should count failures when jobs do not exist', async () => {
      const mockQueue = createMockQueue();
      mockQueue.getJob
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(createMockJob({ id: 'job-2' }));
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.bulkAction(
        JobQueue.AuditLog,
        'retry',
        ['nonexistent', 'job-2'],
      );

      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(1);
    });

    it('should count failures when job action throws', async () => {
      const mockJob = createMockJob({ id: 'job-1' });
      mockJob.retry.mockRejectedValue(new Error('Already active'));
      const mockQueue = createMockQueue();
      mockQueue.getJob.mockResolvedValue(mockJob);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.bulkAction(
        JobQueue.AuditLog,
        'retry',
        ['job-1'],
      );

      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);
    });
  });
});
