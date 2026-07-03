import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueueAdminService } from '../queue-admin.service';
import { JobQueue } from '@arcaai/domains';

const createMockQueue = (overrides: Partial<{
  isPaused: boolean;
  jobCounts: Record<string, number>;
}> = {}) => ({
  name: 'TestQueue',
  isPaused: vi.fn().mockResolvedValue(overrides.isPaused ?? false),
  getJobCounts: vi.fn().mockResolvedValue({
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    paused: 0,
    prioritized: 0,
    ...overrides.jobCounts,
  }),
  getWorkers: vi.fn().mockResolvedValue([]),
  pause: vi.fn().mockResolvedValue(undefined),
  resume: vi.fn().mockResolvedValue(undefined),
  clean: vi.fn().mockResolvedValue([]),
});

const mockModuleRef = {
  get: vi.fn(),
};

describe('QueueAdminService', () => {
  let service: QueueAdminService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new QueueAdminService(mockModuleRef as any);
  });

  describe('getQueueStats', () => {
    it('should return stats for a single queue', async () => {
      const mockQueue = createMockQueue({
        jobCounts: { waiting: 5, active: 2, completed: 100, failed: 3, delayed: 1, paused: 0, prioritized: 0 },
      });
      mockQueue.name = JobQueue.AuditLog;
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getQueueStats(JobQueue.AuditLog);

      expect(result).toEqual({
        name: JobQueue.AuditLog,
        isPaused: false,
        counts: {
          waiting: 5,
          active: 2,
          completed: 100,
          failed: 3,
          delayed: 1,
          paused: 0,
          prioritized: 0,
        },
        workerCount: 0,
      });
    });

    it('should reflect paused state', async () => {
      const mockQueue = createMockQueue({ isPaused: true });
      mockQueue.name = JobQueue.SendEmail;
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getQueueStats(JobQueue.SendEmail);

      expect(result.isPaused).toBe(true);
    });

    it('should count workers', async () => {
      const mockQueue = createMockQueue();
      mockQueue.name = JobQueue.SysEvent;
      mockQueue.getWorkers.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getQueueStats(JobQueue.SysEvent);

      expect(result.workerCount).toBe(2);
    });
  });

  describe('getAllQueueStats', () => {
    it('should return stats for all registered queues', async () => {
      const allQueues = Object.values(JobQueue);
      const mockQueue = createMockQueue();
      mockModuleRef.get.mockReturnValue(mockQueue);

      const results = await service.getAllQueueStats();

      expect(results).toHaveLength(allQueues.length);
      expect(results[0]).toHaveProperty('name');
      expect(results[0]).toHaveProperty('isPaused');
      expect(results[0]).toHaveProperty('counts');
      expect(results[0]).toHaveProperty('workerCount');
    });
  });

  describe('pauseQueue', () => {
    it('should call queue.pause()', async () => {
      const mockQueue = createMockQueue();
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.pauseQueue(JobQueue.AuditLog);

      expect(mockQueue.pause).toHaveBeenCalledOnce();
    });
  });

  describe('resumeQueue', () => {
    it('should call queue.resume()', async () => {
      const mockQueue = createMockQueue();
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.resumeQueue(JobQueue.AuditLog);

      expect(mockQueue.resume).toHaveBeenCalledOnce();
    });
  });

  describe('cleanQueue', () => {
    it('should call queue.clean() with correct parameters', async () => {
      const mockQueue = createMockQueue();
      mockQueue.clean.mockResolvedValue(['job-1', 'job-2']);
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.cleanQueue(
        JobQueue.AuditLog,
        'completed',
        60_000,
        500,
      );

      expect(mockQueue.clean).toHaveBeenCalledWith(60_000, 500, 'completed');
      expect(result).toEqual(['job-1', 'job-2']);
    });

    it('should use default limit of 1000 when not specified', async () => {
      const mockQueue = createMockQueue();
      mockQueue.clean.mockResolvedValue([]);
      mockModuleRef.get.mockReturnValue(mockQueue);

      await service.cleanQueue(JobQueue.AuditLog, 'failed', 30_000);

      expect(mockQueue.clean).toHaveBeenCalledWith(30_000, 1000, 'failed');
    });
  });

  // TASK-403 — Redis health probe for the Queues & Jobs admin surface (design
  // frame `15` health strip). Reads via the first registered queue's shared
  // ioredis connection: PING → latency, INFO → server stats. Never throws.
  describe('getRedisHealth (TASK-403)', () => {
    const REDIS_INFO = [
      'redis_version:7.2.5',
      'uptime_in_seconds:86400',
      'connected_clients:12',
      'used_memory_human:48.31M',
    ].join('\r\n');

    const createMockClient = (overrides: Partial<{ ping: () => Promise<string>; info: () => Promise<string> }> = {}) => ({
      ping: vi.fn(overrides.ping ?? (() => Promise.resolve('PONG'))),
      info: vi.fn(overrides.info ?? (() => Promise.resolve(REDIS_INFO))),
    });

    it('reports a healthy Redis with parsed INFO fields and the registered queue count', async () => {
      const mockQueue = createMockQueue();
      (mockQueue as Record<string, unknown>).client = Promise.resolve(createMockClient());
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getRedisHealth();

      expect(result.status).toBe('healthy');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.connectedClients).toBe(12);
      expect(result.usedMemory).toBe('48.31M');
      expect(result.uptime).toBe(86_400);
      expect(result.version).toBe('7.2.5');
      expect(result.queuesRegistered).toBe(Object.values(JobQueue).length);
    });

    it('degrades (never throws) when PING is slow', async () => {
      const mockQueue = createMockQueue();
      (mockQueue as Record<string, unknown>).client = Promise.resolve(
        createMockClient({ ping: () => new Promise((resolve) => setTimeout(() => resolve('PONG'), 300)) }),
      );
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getRedisHealth();

      expect(result.status).toBe('degraded');
      expect(result.latencyMs).toBeGreaterThanOrEqual(250);
    });

    it('reports unhealthy (never throws) when the connection errors', async () => {
      const mockQueue = createMockQueue();
      (mockQueue as Record<string, unknown>).client = Promise.resolve(
        createMockClient({ ping: () => Promise.reject(new Error('ECONNREFUSED')) }),
      );
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getRedisHealth();

      expect(result.status).toBe('unhealthy');
      expect(result.version).toBe('unknown');
      expect(result.queuesRegistered).toBe(Object.values(JobQueue).length);
    });

    it('reports unhealthy when the queue itself cannot be resolved', async () => {
      mockModuleRef.get.mockImplementation(() => {
        throw new Error('no such provider');
      });

      const result = await service.getRedisHealth();

      expect(result.status).toBe('unhealthy');
    });

    it('tolerates a partial INFO payload with safe fallbacks', async () => {
      const mockQueue = createMockQueue();
      (mockQueue as Record<string, unknown>).client = Promise.resolve(
        createMockClient({ info: () => Promise.resolve('redis_version:7.0.0') }),
      );
      mockModuleRef.get.mockReturnValue(mockQueue);

      const result = await service.getRedisHealth();

      expect(result.version).toBe('7.0.0');
      expect(result.connectedClients).toBe(0);
      expect(result.usedMemory).toBe('unknown');
      expect(result.uptime).toBe(0);
    });
  });
});
