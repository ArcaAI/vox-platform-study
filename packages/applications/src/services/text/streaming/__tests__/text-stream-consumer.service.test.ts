import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TextStreamConsumerService } from '../text-stream-consumer.service';

const createMockConfigService = () => ({
  isRedisConfigured: vi.fn().mockReturnValue(true),
  getRedisConfig: vi.fn().mockReturnValue({
    host: 'localhost',
    port: 6379,
    password: undefined,
  }),
});

const mockXread = vi.fn().mockResolvedValue(null);
const mockQuit = vi.fn().mockResolvedValue('OK');

function MockRedis() {
  return {
    xread: mockXread,
    quit: mockQuit,
  };
}

vi.mock('ioredis', () => {
  return {
    default: MockRedis,
  };
});

describe('TextStreamConsumerService', () => {
  let service: TextStreamConsumerService;
  let mockConfigService: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigService = createMockConfigService();
    service = new TextStreamConsumerService(mockConfigService as any);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('connect', () => {
    it('should establish Redis connection when configured', async () => {
      await service.connect();
      expect(mockConfigService.isRedisConfigured).toHaveBeenCalled();
      expect(mockConfigService.getRedisConfig).toHaveBeenCalled();
    });

    it('should skip connection when Redis is not configured', async () => {
      mockConfigService.isRedisConfigured.mockReturnValue(false);
      await service.connect();
      expect(mockConfigService.getRedisConfig).not.toHaveBeenCalled();
    });

    it('should not reconnect if already connected', async () => {
      await service.connect();
      await service.connect();
      expect(mockConfigService.getRedisConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('disconnect', () => {
    it('should abort active subscriptions on disconnect', async () => {
      await service.connect();
      const obs = service.subscribeToTaskChunks('test-task');
      const sub = obs.subscribe();

      await service.disconnect();
      sub.unsubscribe();
    });

    it('should handle disconnect when not connected', async () => {
      await service.disconnect();
    });
  });

  describe('unsubscribeFromTask', () => {
    it('should abort subscription for given taskId', async () => {
      await service.connect();
      const obs = service.subscribeToTaskChunks('test-task');
      const sub = obs.subscribe();

      service.unsubscribeFromTask('test-task');
      sub.unsubscribe();
    });

    it('should be no-op for unknown taskId', () => {
      service.unsubscribeFromTask('nonexistent');
    });
  });

  describe('subscribeToTaskChunks', () => {
    it('should return an Observable', async () => {
      await service.connect();
      const obs = service.subscribeToTaskChunks('test-task');
      expect(obs).toBeDefined();
      expect(obs.subscribe).toBeDefined();
    });

    it('should support lastEventId for resume', async () => {
      await service.connect();
      const obs = service.subscribeToTaskChunks('test-task', '1234-0');
      expect(obs).toBeDefined();
    });

    it('should clean up subscription on unsubscribe via finalize', async () => {
      await service.connect();
      const obs = service.subscribeToTaskChunks('task-finalize');
      const sub = obs.subscribe();
      sub.unsubscribe();
    });

    it('should emit chunks from Redis stream and complete on done', async () => {
      const textChunk = JSON.stringify({ type: 'text', data: { content: 'hello' } });
      const doneChunk = JSON.stringify({ type: 'done', data: {} });

      mockXread
        .mockResolvedValueOnce([['smr:stream:task-1', [['1-0', ['data', textChunk]]]]])
        .mockResolvedValueOnce([['smr:stream:task-1', [['2-0', ['data', doneChunk]]]]]);

      await service.connect();

      const events: MessageEvent[] = [];
      await new Promise<void>((resolve, reject) => {
        const sub = service.subscribeToTaskChunks('task-1').subscribe({
          next: (event) => events.push(event),
          complete: () => {
            sub.unsubscribe();
            resolve();
          },
          error: (err) => {
            sub.unsubscribe();
            reject(err);
          },
        });
      });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('text');
      expect(events[0].id).toBe('1-0');
      const parsed0 = JSON.parse(events[0].data as unknown as string);
      expect(parsed0.content).toBe('hello');

      expect(events[1].type).toBe('done');
      expect(events[1].id).toBe('2-0');
    });

    it('should skip entries without a data field', async () => {
      const doneChunk = JSON.stringify({ type: 'done', data: {} });

      mockXread
        .mockResolvedValueOnce([['smr:stream:task-2', [['1-0', ['other_field', 'value']]]]])
        .mockResolvedValueOnce([['smr:stream:task-2', [['2-0', ['data', doneChunk]]]]]);

      await service.connect();

      const events: MessageEvent[] = [];
      await new Promise<void>((resolve) => {
        const sub = service.subscribeToTaskChunks('task-2').subscribe({
          next: (event) => events.push(event),
          complete: () => {
            sub.unsubscribe();
            resolve();
          },
        });
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('done');
    });

    it('should skip entries with invalid JSON in data field', async () => {
      const doneChunk = JSON.stringify({ type: 'done', data: {} });

      mockXread
        .mockResolvedValueOnce([['smr:stream:task-3', [['1-0', ['data', 'not-valid-json']]]]])
        .mockResolvedValueOnce([['smr:stream:task-3', [['2-0', ['data', doneChunk]]]]]);

      await service.connect();

      const events: MessageEvent[] = [];
      await new Promise<void>((resolve) => {
        const sub = service.subscribeToTaskChunks('task-3').subscribe({
          next: (event) => events.push(event),
          complete: () => {
            sub.unsubscribe();
            resolve();
          },
        });
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('done');
    });

    it('should complete on error chunk type', async () => {
      const errorChunk = JSON.stringify({ type: 'error', data: { message: 'failed' } });

      mockXread.mockResolvedValueOnce([['smr:stream:task-4', [['1-0', ['data', errorChunk]]]]]);

      await service.connect();

      const events: MessageEvent[] = [];
      await new Promise<void>((resolve) => {
        const sub = service.subscribeToTaskChunks('task-4').subscribe({
          next: (event) => events.push(event),
          complete: () => {
            sub.unsubscribe();
            resolve();
          },
        });
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      const parsed = JSON.parse(events[0].data as unknown as string);
      expect(parsed.message).toBe('failed');
    });

    it('should use default chunk type when type is missing', async () => {
      const noTypeChunk = JSON.stringify({ data: { content: 'test' } });
      const doneChunk = JSON.stringify({ type: 'done', data: {} });

      mockXread
        .mockResolvedValueOnce([['smr:stream:task-5', [['1-0', ['data', noTypeChunk]]]]])
        .mockResolvedValueOnce([['smr:stream:task-5', [['2-0', ['data', doneChunk]]]]]);

      await service.connect();

      const events: MessageEvent[] = [];
      await new Promise<void>((resolve) => {
        const sub = service.subscribeToTaskChunks('task-5').subscribe({
          next: (event) => events.push(event),
          complete: () => {
            sub.unsubscribe();
            resolve();
          },
        });
      });

      expect(events[0].type).toBe('chunk');
    });
  });

  describe('onModuleDestroy', () => {
    it('should disconnect cleanly', async () => {
      await service.connect();
      await service.onModuleDestroy();
    });

    it('should handle destroy when not connected', async () => {
      await service.onModuleDestroy();
    });
  });
});
