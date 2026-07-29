/**
 * RedisSubscriberService Unit Tests
 *
 * Tests the dedicated Redis subscriber service that manages per-channel
 * Pub/Sub subscriptions with reference counting.
 *
 * Testing Strategy:
 * - Mock ioredis to avoid network calls
 * - Verify connection lifecycle (init, destroy)
 * - Test channel subscription and message dispatch
 * - Test reference counting and cleanup
 * - Test graceful degradation when Redis is unavailable
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { RedisSubscriberService } from '../redisSubscriber.service';
import { IConfigService } from '../../../baseServices/_meta/config';

// Mock ioredis - external network boundary
vi.mock('ioredis', () => {
  return {
    default: vi.fn(),
  };
});

import Redis from 'ioredis';

describe('RedisSubscriberService', () => {
  let service: RedisSubscriberService;
  let mockConfigService: IConfigService;
  let mockRedisInstance: any;

  /**
   * Stored event handlers from Redis .on() calls,
   * so tests can trigger them manually.
   */
  let eventHandlers: Record<string, Function>;

  const createMockConfigService = (configured: boolean = true): IConfigService =>
    ({
      isRedisConfigured: vi.fn().mockReturnValue(configured),
      getRedisConfig: vi.fn().mockReturnValue({
        host: 'localhost',
        port: 6379,
        password: 'testpass',
      }),
      getConfiguration: vi.fn().mockReturnValue({}),
    }) as unknown as IConfigService;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers = {};

    mockConfigService = createMockConfigService();

    mockRedisInstance = {
      on: vi.fn().mockImplementation((event: string, callback: Function) => {
        eventHandlers[event] = callback;
        return mockRedisInstance;
      }),
      once: vi.fn().mockImplementation((event: string, callback: Function) => {
        if (event === 'ready') {
          setImmediate(() => callback());
        }
        return mockRedisInstance;
      }),
      subscribe: vi.fn().mockResolvedValue(1),
      unsubscribe: vi.fn().mockResolvedValue(1),
      quit: vi.fn().mockResolvedValue('OK'),
      status: 'ready',
    };

    (Redis as unknown as Mock).mockImplementation(function () {
      return mockRedisInstance;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: initialize service with Redis connected.
   * Creates the service, calls onModuleInit, then triggers
   * the 'connect' event handler to set connected = true.
   * Also assigns to the outer `service` variable for convenience.
   */
  async function initConnectedService(): Promise<RedisSubscriberService> {
    service = new RedisSubscriberService(mockConfigService);
    await service.onModuleInit();

    // Trigger the connect handler that was registered via .on('connect', ...)
    // This simulates ioredis emitting the 'connect' event after TCP connection.
    expect(eventHandlers['connect']).toBeDefined();
    eventHandlers['connect']();
    expect(service.isConnected()).toBe(true);

    return service;
  }

  // -----------------------------------------------------------------------
  // Constructor and lifecycle
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('should create service without config service', () => {
      service = new RedisSubscriberService();
      expect(service).toBeDefined();
    });

    it('should create service with config service', () => {
      service = new RedisSubscriberService(mockConfigService);
      expect(service).toBeDefined();
    });
  });

  describe('onModuleInit', () => {
    it('should not connect when config service is not available', async () => {
      service = new RedisSubscriberService();
      await service.onModuleInit();

      expect(Redis).not.toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
    });

    it('should not connect when Redis is not configured', async () => {
      mockConfigService = createMockConfigService(false);
      service = new RedisSubscriberService(mockConfigService);
      await service.onModuleInit();

      expect(Redis).not.toHaveBeenCalled();
      expect(service.isConnected()).toBe(false);
    });

    it('should create Redis client with correct config', async () => {
      service = new RedisSubscriberService(mockConfigService);
      await service.onModuleInit();

      expect(Redis).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'localhost',
          port: 6379,
          password: 'testpass',
          maxRetriesPerRequest: null, // Required for subscriber mode
        }),
      );
    });

    it('should register event handlers on Redis client', async () => {
      service = new RedisSubscriberService(mockConfigService);
      await service.onModuleInit();

      expect(mockRedisInstance.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockRedisInstance.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockRedisInstance.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockRedisInstance.on).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('should set connected=true when connect event fires', async () => {
      service = new RedisSubscriberService(mockConfigService);
      await service.onModuleInit();

      // Before connect event, should not be connected
      expect(service.isConnected()).toBe(false);

      // Verify handler was captured
      expect(eventHandlers['connect']).toBeDefined();
      expect(typeof eventHandlers['connect']).toBe('function');

      // Fire the connect event
      eventHandlers['connect']();

      // Now should be connected
      expect(service.isConnected()).toBe(true);
    });

    it('should set connected=false when error event fires', async () => {
      service = await initConnectedService();
      expect(service.isConnected()).toBe(true);

      eventHandlers['error'](new Error('test error'));
      expect(service.isConnected()).toBe(false);
    });

    it('should set connected=false when close event fires', async () => {
      service = await initConnectedService();
      expect(service.isConnected()).toBe(true);

      eventHandlers['close']();
      expect(service.isConnected()).toBe(false);
    });
  });

  describe('onModuleDestroy', () => {
    it('should not throw when not connected', async () => {
      service = new RedisSubscriberService();
      await service.onModuleInit();

      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });

    it('should disconnect Redis client', async () => {
      service = await initConnectedService();
      await service.onModuleDestroy();

      expect(mockRedisInstance.quit).toHaveBeenCalled();
    });

    it('should complete all active channel subjects', async () => {
      service = await initConnectedService();

      let completed = false;
      (await service.subscribeToChannel('test:channel')).subscribe({
        complete: () => {
          completed = true;
        },
      });

      await service.onModuleDestroy();
      expect(completed).toBe(true);
    });

    it('should handle quit error gracefully', async () => {
      service = await initConnectedService();
      mockRedisInstance.quit.mockRejectedValueOnce(new Error('Quit failed'));

      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // isConnected
  // -----------------------------------------------------------------------

  describe('isConnected', () => {
    it('should return false when not initialized', () => {
      service = new RedisSubscriberService();
      expect(service.isConnected()).toBe(false);
    });

    it('should return false when config service is not available', async () => {
      service = new RedisSubscriberService();
      await service.onModuleInit();
      expect(service.isConnected()).toBe(false);
    });

    it('should return true after successful connection', async () => {
      service = await initConnectedService();
      expect(service.isConnected()).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // subscribeToChannel
  // -----------------------------------------------------------------------

  describe('subscribeToChannel', () => {
    it('should return completing observable when not connected', async () => {
      service = new RedisSubscriberService();
      await service.onModuleInit();

      const messages: string[] = [];
      let completed = false;

      (await service.subscribeToChannel('test:channel')).subscribe({
        next: (msg) => messages.push(msg),
        complete: () => {
          completed = true;
        },
      });

      expect(completed).toBe(true);
      expect(messages).toHaveLength(0);
    });

    it('should subscribe to Redis channel', async () => {
      service = await initConnectedService();

      await service.subscribeToChannel('stt:transcription:job-123');

      expect(mockRedisInstance.subscribe).toHaveBeenCalledWith('stt:transcription:job-123');
    });

    it('should dispatch messages from Redis to observers', async () => {
      service = await initConnectedService();

      const messages: string[] = [];
      (await service.subscribeToChannel('stt:transcription:job-123')).subscribe({
        next: (msg) => messages.push(msg),
      });

      // Simulate Redis message via the message handler
      const testEvent = JSON.stringify({
        type: 'chunk',
        data: { jobId: 'job-123', chunkIndex: 0, text: 'Hello world' },
      });
      eventHandlers['message']('stt:transcription:job-123', testEvent);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toBe(testEvent);
    });

    it('should not dispatch messages for unsubscribed channels', async () => {
      service = await initConnectedService();

      const messages: string[] = [];
      (await service.subscribeToChannel('stt:transcription:job-123')).subscribe({
        next: (msg) => messages.push(msg),
      });

      // Send message to a different channel
      eventHandlers['message']('stt:transcription:other-job', 'some data');

      expect(messages).toHaveLength(0);
    });

    it('should share Redis subscription for same channel', async () => {
      service = await initConnectedService();

      const messages1: string[] = [];
      const messages2: string[] = [];

      (await service.subscribeToChannel('shared:channel')).subscribe({
        next: (msg) => messages1.push(msg),
      });
      (await service.subscribeToChannel('shared:channel')).subscribe({
        next: (msg) => messages2.push(msg),
      });

      // Redis.subscribe should be called only once for the same channel
      expect(mockRedisInstance.subscribe).toHaveBeenCalledTimes(1);

      // Both observers should receive the message
      eventHandlers['message']('shared:channel', 'hello');

      expect(messages1).toEqual(['hello']);
      expect(messages2).toEqual(['hello']);
    });

    it('should handle Redis subscribe failure gracefully', async () => {
      service = await initConnectedService();

      mockRedisInstance.subscribe.mockRejectedValueOnce(new Error('Subscribe failed'));

      const errors: Error[] = [];
      try {
        await service.subscribeToChannel('fail:channel');
      } catch (err) {
        errors.push(err as Error);
      }

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Subscribe failed');
    });

    it('should support multiple different channels simultaneously', async () => {
      service = await initConnectedService();

      const messagesA: string[] = [];
      const messagesB: string[] = [];

      (await service.subscribeToChannel('channel:a')).subscribe({
        next: (msg) => messagesA.push(msg),
      });
      (await service.subscribeToChannel('channel:b')).subscribe({
        next: (msg) => messagesB.push(msg),
      });

      expect(mockRedisInstance.subscribe).toHaveBeenCalledTimes(2);

      eventHandlers['message']('channel:a', 'msg-a');
      eventHandlers['message']('channel:b', 'msg-b');

      expect(messagesA).toEqual(['msg-a']);
      expect(messagesB).toEqual(['msg-b']);
    });
  });

  // -----------------------------------------------------------------------
  // unsubscribeFromChannel
  // -----------------------------------------------------------------------

  describe('unsubscribeFromChannel', () => {
    it('should complete the channel subject', async () => {
      service = await initConnectedService();

      let completed = false;
      (await service.subscribeToChannel('test:channel')).subscribe({
        complete: () => {
          completed = true;
        },
      });

      service.unsubscribeFromChannel('test:channel');
      expect(completed).toBe(true);
    });

    it('should unsubscribe from Redis', async () => {
      await initConnectedService();

      const sub = (await service.subscribeToChannel('test:channel')).subscribe();

      service.unsubscribeFromChannel('test:channel');

      expect(mockRedisInstance.unsubscribe).toHaveBeenCalledWith('test:channel');
      sub.unsubscribe();
    });

    it('should be safe to call for non-subscribed channel', async () => {
      service = await initConnectedService();

      // Should not throw
      service.unsubscribeFromChannel('nonexistent:channel');
      expect(mockRedisInstance.unsubscribe).not.toHaveBeenCalled();
    });

    it('should stop dispatching messages after unsubscribe', async () => {
      await initConnectedService();

      const messages: string[] = [];
      (await service.subscribeToChannel('test:channel')).subscribe({
        next: (msg) => messages.push(msg),
      });

      // Verify message handler is registered
      expect(eventHandlers['message']).toBeDefined();

      // Receive one message
      eventHandlers['message']('test:channel', 'message-1');
      expect(messages).toHaveLength(1);

      // Unsubscribe
      service.unsubscribeFromChannel('test:channel');

      // Further messages should not be dispatched (subject is completed, channel removed)
      eventHandlers['message']('test:channel', 'message-2');
      expect(messages).toHaveLength(1);
    });

    it('should handle Redis unsubscribe failure gracefully', async () => {
      service = await initConnectedService();

      mockRedisInstance.unsubscribe.mockRejectedValueOnce(new Error('Unsubscribe failed'));

      await service.subscribeToChannel('fail:channel');

      // Should not throw
      expect(() => service.unsubscribeFromChannel('fail:channel')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Reference counting
  // -----------------------------------------------------------------------

  describe('reference counting', () => {
    it('should not unsubscribe from Redis when observers remain', async () => {
      service = await initConnectedService();

      const sub1 = (await service.subscribeToChannel('counted:channel')).subscribe();
      (await service.subscribeToChannel('counted:channel')).subscribe();

      // Unsubscribe first observer
      sub1.unsubscribe();

      // Redis should NOT be unsubscribed — still has one observer
      expect(mockRedisInstance.unsubscribe).not.toHaveBeenCalled();
    });

    it('should unsubscribe from Redis when last observer leaves', async () => {
      service = await initConnectedService();

      const sub1 = (await service.subscribeToChannel('counted:channel')).subscribe();
      const sub2 = (await service.subscribeToChannel('counted:channel')).subscribe();

      sub1.unsubscribe();
      expect(mockRedisInstance.unsubscribe).not.toHaveBeenCalled();

      sub2.unsubscribe();
      expect(mockRedisInstance.unsubscribe).toHaveBeenCalledWith('counted:channel');
    });

    it('should allow re-subscribing after all observers leave', async () => {
      service = await initConnectedService();

      // First subscription
      const sub1 = (await service.subscribeToChannel('reuse:channel')).subscribe();

      sub1.unsubscribe();
      expect(mockRedisInstance.unsubscribe).toHaveBeenCalledTimes(1);

      // Re-subscribe
      mockRedisInstance.subscribe.mockClear();
      mockRedisInstance.unsubscribe.mockClear();

      const messages: string[] = [];
      (await service.subscribeToChannel('reuse:channel')).subscribe({
        next: (msg) => messages.push(msg),
      });

      // Should create a new Redis subscription
      expect(mockRedisInstance.subscribe).toHaveBeenCalledWith('reuse:channel');

      // And dispatch messages
      eventHandlers['message']('reuse:channel', 'new-message');
      expect(messages).toEqual(['new-message']);
    });
  });

  // -----------------------------------------------------------------------
  // Graceful degradation
  // -----------------------------------------------------------------------

  describe('graceful degradation', () => {
    it('should not throw when subscribing without connection', async () => {
      service = new RedisSubscriberService();
      await service.onModuleInit();

      await expect(service.subscribeToChannel('test:channel')).resolves.not.toThrow();
    });

    it('should not throw when unsubscribing without connection', async () => {
      service = new RedisSubscriberService();
      await service.onModuleInit();

      expect(() => service.unsubscribeFromChannel('test:channel')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // retryStrategy
  // -----------------------------------------------------------------------

  describe('retryStrategy', () => {
    it('should return correct delays and stop after 3 retries', async () => {
      // Access the Redis constructor args after onModuleInit to extract retryStrategy
      service = new RedisSubscriberService(mockConfigService);
      await service.onModuleInit();

      // The Redis mock was called with config containing retryStrategy
      expect(Redis).toHaveBeenCalledTimes(1);
      const constructorConfig = (Redis as unknown as Mock).mock.calls[0][0];
      const retryStrategy = constructorConfig.retryStrategy;

      expect(retryStrategy).toBeDefined();
      expect(typeof retryStrategy).toBe('function');

      // Within retry limit: linear backoff capped at 2000ms
      expect(retryStrategy(1)).toBe(200); // min(1*200, 2000) = 200
      expect(retryStrategy(2)).toBe(400); // min(2*200, 2000) = 400
      expect(retryStrategy(3)).toBe(600); // min(3*200, 2000) = 600

      // Beyond retry limit: returns null to stop retrying
      expect(retryStrategy(4)).toBeNull();
      expect(retryStrategy(10)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Constructor error handling
  // -----------------------------------------------------------------------

  describe('error handling during connect', () => {
    it('should handle constructor error gracefully', async () => {
      (Redis as unknown as Mock).mockImplementation(() => {
        throw new Error('Connection initialization failed');
      });

      service = new RedisSubscriberService(mockConfigService);
      // Should not throw
      await expect(service.onModuleInit()).resolves.not.toThrow();
      expect(service.isConnected()).toBe(false);
    });

    it('should handle non-Error thrown during connect', async () => {
      (Redis as unknown as Mock).mockImplementation(() => {
        throw 'string error';
      });

      service = new RedisSubscriberService(mockConfigService);
      await expect(service.onModuleInit()).resolves.not.toThrow();
      expect(service.isConnected()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // message handler edge cases
  // -----------------------------------------------------------------------

  describe('message handler edge cases', () => {
    it('should silently ignore messages for unknown channels', async () => {
      await initConnectedService();

      // No subscriptions, but message arrives — should not throw
      expect(() => {
        eventHandlers['message']('unknown:channel', 'data');
      }).not.toThrow();
    });

    it('should handle empty message strings', async () => {
      await initConnectedService();

      const messages: string[] = [];
      (await service.subscribeToChannel('test:channel')).subscribe({
        next: (msg) => messages.push(msg),
      });

      eventHandlers['message']('test:channel', '');
      expect(messages).toEqual(['']);
    });

    it('should handle very large messages', async () => {
      await initConnectedService();

      const messages: string[] = [];
      (await service.subscribeToChannel('test:channel')).subscribe({
        next: (msg) => messages.push(msg),
      });

      const largeMessage = 'x'.repeat(100_000);
      eventHandlers['message']('test:channel', largeMessage);
      expect(messages).toHaveLength(1);
      expect(messages[0].length).toBe(100_000);
    });

    it('should deliver multiple rapid messages in order', async () => {
      await initConnectedService();

      const messages: string[] = [];
      (await service.subscribeToChannel('rapid:channel')).subscribe({
        next: (msg) => messages.push(msg),
      });

      for (let i = 0; i < 100; i++) {
        eventHandlers['message']('rapid:channel', `msg-${i}`);
      }

      expect(messages).toHaveLength(100);
      expect(messages[0]).toBe('msg-0');
      expect(messages[99]).toBe('msg-99');
    });

    it('should ignore messages for channels that were unsubscribed', async () => {
      await initConnectedService();

      const messages: string[] = [];
      (await service.subscribeToChannel('temp:channel')).subscribe({
        next: (msg) => messages.push(msg),
      });

      eventHandlers['message']('temp:channel', 'before');
      expect(messages).toHaveLength(1);

      service.unsubscribeFromChannel('temp:channel');

      // After unsubscribe, channel Subject is removed from the map
      eventHandlers['message']('temp:channel', 'after');
      expect(messages).toHaveLength(1); // Still 1 — 'after' was ignored
    });
  });

  // -----------------------------------------------------------------------
  // Disconnect during active subscriptions
  // -----------------------------------------------------------------------

  describe('disconnect during active subscriptions', () => {
    it('should complete all observers when module destroys mid-stream', async () => {
      service = await initConnectedService();

      const received: string[] = [];
      let completed = false;

      (await service.subscribeToChannel('active:ch')).subscribe({
        next: (msg) => received.push(msg),
        complete: () => {
          completed = true;
        },
      });

      eventHandlers['message']('active:ch', 'msg-1');
      expect(received).toHaveLength(1);

      await service.onModuleDestroy();

      expect(completed).toBe(true);
      expect(service.isConnected()).toBe(false);
    });

    it('should complete observers across multiple channels on destroy', async () => {
      service = await initConnectedService();

      const completions: string[] = [];

      (await service.subscribeToChannel('ch:a')).subscribe({
        complete: () => completions.push('ch:a'),
      });
      (await service.subscribeToChannel('ch:b')).subscribe({
        complete: () => completions.push('ch:b'),
      });
      (await service.subscribeToChannel('ch:c')).subscribe({
        complete: () => completions.push('ch:c'),
      });

      await service.onModuleDestroy();

      expect(completions).toHaveLength(3);
      expect(completions).toContain('ch:a');
      expect(completions).toContain('ch:b');
      expect(completions).toContain('ch:c');
    });
  });

  // -----------------------------------------------------------------------
  // Connection loss recovery
  // -----------------------------------------------------------------------

  describe('connection loss recovery', () => {
    it('should not call Redis unsubscribe when connection is lost', async () => {
      service = await initConnectedService();

      await service.subscribeToChannel('test:ch');

      // Simulate connection loss
      eventHandlers['close']();
      expect(service.isConnected()).toBe(false);

      // Explicit unsubscribe while disconnected should skip Redis call
      service.unsubscribeFromChannel('test:ch');
      expect(mockRedisInstance.unsubscribe).not.toHaveBeenCalled();
    });

    it('should return completing observable when subscribing after connection loss', async () => {
      service = await initConnectedService();

      // Lose connection
      eventHandlers['error'](new Error('Network unreachable'));
      expect(service.isConnected()).toBe(false);

      // New subscription attempt should get an immediately-completing observable
      let completed = false;
      const messages: string[] = [];
      (await service.subscribeToChannel('new:ch')).subscribe({
        next: (msg) => messages.push(msg),
        complete: () => {
          completed = true;
        },
      });

      expect(completed).toBe(true);
      expect(messages).toHaveLength(0);
    });
  });
});
