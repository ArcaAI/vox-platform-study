import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { firstValueFrom, take, toArray } from 'rxjs';

vi.mock('bullmq', () => {
  const EventEmitter = require('events');

  class MockQueueEvents extends EventEmitter {
    constructor(
      public queueName: string,
      _opts?: any,
    ) {
      super();
    }
    close = vi.fn().mockResolvedValue(undefined);
  }

  return { QueueEvents: MockQueueEvents };
});

import { QueueEventsService } from '../queue-events.service';
import { QueueEvents } from 'bullmq';

const mockConfigService = {
  getRedisConfig: vi.fn().mockReturnValue({
    host: 'localhost',
    port: 6379,
    password: undefined,
  }),
};

describe('QueueEventsService', () => {
  let service: QueueEventsService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new QueueEventsService(mockConfigService as any);
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  describe('getEventStream', () => {
    it('should return an Observable that emits SSE MessageEvents', async () => {
      const stream$ = service.getEventStream(['TestQueue']);

      const emitPromise = firstValueFrom(stream$);

      // Simulate a BullMQ event on the underlying QueueEvents
      const qeInstances = (service as any).queueEventsInstances;
      const qe = qeInstances.get('TestQueue');
      expect(qe).toBeDefined();

      qe.emit('completed', { jobId: 'job-1', returnvalue: '{"ok":true}' });

      const event = await emitPromise;

      expect(event).toHaveProperty('data');
      expect(event).toHaveProperty('type', 'job:completed');
      const parsed = JSON.parse(event.data as string);
      expect(parsed.type).toBe('job:completed');
      expect(parsed.queueName).toBe('TestQueue');
      expect(parsed.jobId).toBe('job-1');
    });

    it('should filter events by type when eventTypes are specified', async () => {
      const stream$ = service.getEventStream(['TestQueue'], ['job:failed']);

      const qe = (service as any).queueEventsInstances.get('TestQueue');

      setTimeout(() => {
        qe.emit('completed', { jobId: 'job-1', returnvalue: '' });
        qe.emit('failed', { jobId: 'job-2', failedReason: 'timeout' });
      }, 10);

      const event = await firstValueFrom(stream$);

      const parsed = JSON.parse(event.data as string);
      expect(parsed.type).toBe('job:failed');
      expect(parsed.jobId).toBe('job-2');
    });

    it('should merge events from multiple queues', async () => {
      const stream$ = service.getEventStream(['QueueA', 'QueueB']);
      const collected$ = stream$.pipe(take(2), toArray());

      const qeA = (service as any).queueEventsInstances.get('QueueA');
      const qeB = (service as any).queueEventsInstances.get('QueueB');

      setTimeout(() => {
        qeA.emit('completed', { jobId: 'a-1', returnvalue: '' });
        qeB.emit('failed', { jobId: 'b-1', failedReason: 'err' });
      }, 10);

      const events = await firstValueFrom(collected$);

      expect(events).toHaveLength(2);
      const queues = events.map((e) => JSON.parse(e.data as string).queueName);
      expect(queues).toContain('QueueA');
      expect(queues).toContain('QueueB');
    });

    it('should emit active events', async () => {
      const stream$ = service.getEventStream(['TestQueue']);
      const qe = (service as any).queueEventsInstances.get('TestQueue');

      setTimeout(() => {
        qe.emit('active', { jobId: 'job-3', prev: 'waiting' });
      }, 10);

      const event = await firstValueFrom(stream$);
      const parsed = JSON.parse(event.data as string);
      expect(parsed.type).toBe('job:active');
    });

    it('should emit waiting events', async () => {
      const stream$ = service.getEventStream(['TestQueue']);
      const qe = (service as any).queueEventsInstances.get('TestQueue');

      setTimeout(() => {
        qe.emit('waiting', { jobId: 'job-4' });
      }, 10);

      const event = await firstValueFrom(stream$);
      const parsed = JSON.parse(event.data as string);
      expect(parsed.type).toBe('job:waiting');
    });

    it('should emit stalled events', async () => {
      const stream$ = service.getEventStream(['TestQueue']);
      const qe = (service as any).queueEventsInstances.get('TestQueue');

      setTimeout(() => {
        qe.emit('stalled', { jobId: 'job-5' });
      }, 10);

      const event = await firstValueFrom(stream$);
      const parsed = JSON.parse(event.data as string);
      expect(parsed.type).toBe('job:stalled');
    });

    it('should emit progress events', async () => {
      const stream$ = service.getEventStream(['TestQueue']);
      const qe = (service as any).queueEventsInstances.get('TestQueue');

      setTimeout(() => {
        qe.emit('progress', { jobId: 'job-6', data: 75 });
      }, 10);

      const event = await firstValueFrom(stream$);
      const parsed = JSON.parse(event.data as string);
      expect(parsed.type).toBe('job:progress');
      expect(parsed.progress).toBe(75);
    });
  });

  describe('ref-counting lifecycle', () => {
    it('should share QueueEvents instance for the same queue across subscribers', () => {
      service.getEventStream(['SharedQueue']);
      service.getEventStream(['SharedQueue']);

      const instances = (service as any).queueEventsInstances;
      expect(instances.size).toBe(1);

      const refCounts = (service as any).refCounts;
      expect(refCounts.get('SharedQueue')).toBe(2);
    });

    it('should clean up QueueEvents when last subscriber disconnects', async () => {
      const stream$ = service.getEventStream(['CleanupQueue']);

      const instances = (service as any).queueEventsInstances;
      expect(instances.has('CleanupQueue')).toBe(true);

      const sub = stream$.subscribe();
      sub.unsubscribe();

      // After unsubscribe, finalize should have decremented refcount to 0
      // and cleaned up
      expect(instances.has('CleanupQueue')).toBe(false);
    });

    it('should keep QueueEvents alive while at least one subscriber remains', () => {
      const stream1$ = service.getEventStream(['KeepAliveQueue']);
      const stream2$ = service.getEventStream(['KeepAliveQueue']);

      const sub1 = stream1$.subscribe();
      const sub2 = stream2$.subscribe();

      sub1.unsubscribe();

      const instances = (service as any).queueEventsInstances;
      expect(instances.has('KeepAliveQueue')).toBe(true);

      const refCounts = (service as any).refCounts;
      expect(refCounts.get('KeepAliveQueue')).toBe(1);

      sub2.unsubscribe();
      expect(instances.has('KeepAliveQueue')).toBe(false);
    });
  });

  describe('onModuleDestroy', () => {
    it('should close all QueueEvents instances and clear maps', async () => {
      service.getEventStream(['Queue1']);
      service.getEventStream(['Queue2']);

      const instances = (service as any).queueEventsInstances;
      const q1 = instances.get('Queue1');
      const q2 = instances.get('Queue2');

      await service.onModuleDestroy();

      expect(q1.close).toHaveBeenCalled();
      expect(q2.close).toHaveBeenCalled();
      expect(instances.size).toBe(0);
      expect((service as any).subjects.size).toBe(0);
      expect((service as any).refCounts.size).toBe(0);
    });
  });
});
