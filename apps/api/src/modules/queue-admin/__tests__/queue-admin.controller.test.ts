import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { QueueAdminController } from '../queue-admin.controller';

// Guarded admin surface over the existing
// queue-admin application layer (BullMQ queues + jobs). The controller is a
// thin delegate: every route forwards to IQueueAdminService / IJobAdminService.
const mockQueueService = {
  getAllQueueStats: vi.fn(),
  getQueueStats: vi.fn(),
  pauseQueue: vi.fn(),
  resumeQueue: vi.fn(),
  cleanQueue: vi.fn(),
  getRedisHealth: vi.fn(),
};

const mockJobService = {
  listJobs: vi.fn(),
  getJobDetail: vi.fn(),
  retryJob: vi.fn(),
  removeJob: vi.fn(),
  promoteJob: vi.fn(),
  bulkAction: vi.fn(),
};

describe('QueueAdminController', () => {
  let controller: QueueAdminController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new QueueAdminController(mockQueueService as never, mockJobService as never);
  });

  describe('queues', () => {
    it('lists all queue stats', async () => {
      const stats = [{ name: 'SendEmail', isPaused: false, counts: {}, workerCount: 1 }];
      mockQueueService.getAllQueueStats.mockResolvedValue(stats);

      const result = await controller.listQueues();

      expect(mockQueueService.getAllQueueStats).toHaveBeenCalledWith();
      expect(result).toEqual(stats);
    });

    it('gets a single queue stat by name', async () => {
      const stat = { name: 'SendEmail', isPaused: false, counts: {}, workerCount: 1 };
      mockQueueService.getQueueStats.mockResolvedValue(stat);

      const result = await controller.getQueue('SendEmail');

      expect(mockQueueService.getQueueStats).toHaveBeenCalledWith('SendEmail');
      expect(result).toEqual(stat);
    });

    it('pauses a queue and returns an ack', async () => {
      mockQueueService.pauseQueue.mockResolvedValue(undefined);

      const result = await controller.pauseQueue('SendEmail');

      expect(mockQueueService.pauseQueue).toHaveBeenCalledWith('SendEmail');
      expect(result).toEqual({ success: true });
    });

    it('resumes a queue and returns an ack', async () => {
      mockQueueService.resumeQueue.mockResolvedValue(undefined);

      const result = await controller.resumeQueue('SendEmail');

      expect(mockQueueService.resumeQueue).toHaveBeenCalledWith('SendEmail');
      expect(result).toEqual({ success: true });
    });

    it('cleans a queue with the supplied status/grace/limit and returns the removed ids', async () => {
      mockQueueService.cleanQueue.mockResolvedValue(['1', '2', '3']);

      const result = await controller.cleanQueue('SendEmail', { status: 'failed', gracePeriodMs: 1000, limit: 50 });

      expect(mockQueueService.cleanQueue).toHaveBeenCalledWith('SendEmail', 'failed', 1000, 50);
      expect(result).toEqual({ removedJobIds: ['1', '2', '3'], count: 3 });
    });

    it('returns the Redis health snapshot from the service', async () => {
      const health = {
        status: 'healthy',
        latencyMs: 3,
        connectedClients: 8,
        usedMemory: '12.00M',
        uptime: 1000,
        version: '7.2.5',
        queuesRegistered: 15,
      };
      mockQueueService.getRedisHealth.mockResolvedValue(health);

      const result = await controller.getRedisHealth();

      expect(mockQueueService.getRedisHealth).toHaveBeenCalledWith();
      expect(result).toEqual(health);
    });
  });

  describe('jobs', () => {
    it('lists jobs for a queue (paginated, status-filtered)', async () => {
      const paginated = { items: [], total: 0, page: 1, limit: 20 };
      mockJobService.listJobs.mockResolvedValue(paginated);
      const query = { page: 1, limit: 20, status: 'failed' };

      const result = await controller.listJobs('SendEmail', query);

      expect(mockJobService.listJobs).toHaveBeenCalledWith('SendEmail', query);
      expect(result).toEqual(paginated);
    });

    it('gets a job detail (PII-redacted by the service)', async () => {
      const detail = { id: 'job-1', name: 'send', queueName: 'SendEmail', data: {} };
      mockJobService.getJobDetail.mockResolvedValue(detail);

      const result = await controller.getJob('SendEmail', 'job-1');

      expect(mockJobService.getJobDetail).toHaveBeenCalledWith('SendEmail', 'job-1');
      expect(result).toEqual(detail);
    });

    it('retries a job and returns an ack', async () => {
      mockJobService.retryJob.mockResolvedValue(undefined);

      const result = await controller.retryJob('SendEmail', 'job-1');

      expect(mockJobService.retryJob).toHaveBeenCalledWith('SendEmail', 'job-1');
      expect(result).toEqual({ success: true });
    });

    it('promotes a delayed job and returns an ack', async () => {
      mockJobService.promoteJob.mockResolvedValue(undefined);

      const result = await controller.promoteJob('SendEmail', 'job-1');

      expect(mockJobService.promoteJob).toHaveBeenCalledWith('SendEmail', 'job-1');
      expect(result).toEqual({ success: true });
    });

    it('removes a job and returns an ack', async () => {
      mockJobService.removeJob.mockResolvedValue(undefined);

      const result = await controller.removeJob('SendEmail', 'job-1');

      expect(mockJobService.removeJob).toHaveBeenCalledWith('SendEmail', 'job-1');
      expect(result).toEqual({ success: true });
    });

    it('runs a bulk job action and returns the result counts', async () => {
      const bulk = { succeeded: 2, failed: 1 };
      mockJobService.bulkAction.mockResolvedValue(bulk);

      const result = await controller.bulkJobAction('SendEmail', { action: 'retry', jobIds: ['1', '2', '3'] });

      expect(mockJobService.bulkAction).toHaveBeenCalledWith('SendEmail', 'retry', ['1', '2', '3']);
      expect(result).toEqual(bulk);
    });
  });

  describe('access gate', () => {
    // Queues/jobs are PLATFORM-wide infrastructure (not tenant-scoped), so the
    // surface is gated to SUPER_ADMIN via `@Authorize(['manage','all'])` — the
    // same posture as the rate-limit admin surface. Tenant admins must NOT be
    // able to pause/clean platform queues.
    it('is class-gated by @Authorize(["manage","all"]) (SUPER_ADMIN only)', () => {
      const meta = Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, QueueAdminController) as Array<{ action: string; subject: string }> | undefined;
      expect(meta).toEqual([{ action: 'manage', subject: 'all' }]);
    });
  });
});
