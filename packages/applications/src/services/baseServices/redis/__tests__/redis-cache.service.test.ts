/**
 * RedisCacheService Unit Tests
 *
 * Tests for the Redis caching service with graceful fallback when Redis is unavailable.
 *
 * Testing Strategy:
 * - Mock ioredis (external boundary) to avoid network calls
 * - Verify graceful fallback behavior when Redis is unavailable
 * - Test actual cache operations return correct values
 * - Ensure service doesn't throw when disconnected
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { RedisCacheService } from '../redis-cache.service';
import { IConfigService } from '../../_meta/config';

// Mock ioredis - external network boundary
vi.mock('ioredis', () => {
    return {
        default: vi.fn(),
    };
});

import Redis from 'ioredis';

describe('RedisCacheService', () => {
    let service: RedisCacheService;
    let mockConfigService: IConfigService;
    let mockRedisInstance: any;

    /**
     * Creates a complete mock config service.
     * Matches the real IConfigService interface.
     */
    const createMockConfigService = (configured: boolean = true): IConfigService => ({
        isRedisConfigured: vi.fn().mockReturnValue(configured),
        getRedisConfig: vi.fn().mockReturnValue({
            host: 'localhost',
            port: 6379,
            password: 'testpass',
        }),
        getConfiguration: vi.fn().mockReturnValue({}),
    } as unknown as IConfigService);

    beforeEach(() => {
        vi.clearAllMocks();

        mockConfigService = createMockConfigService();

        /**
         * Complete Redis mock matching ioredis interface.
         * Includes all methods that might be called during cache operations.
         */
        mockRedisInstance = {
            on: vi.fn().mockReturnThis(),
            once: vi.fn().mockImplementation((event: string, callback: Function) => {
                // Immediately resolve for 'ready' event in tests
                if (event === 'ready') {
                    setImmediate(() => callback());
                }
                return mockRedisInstance;
            }),
            removeListener: vi.fn(),
            get: vi.fn().mockResolvedValue('cached-value'),
            set: vi.fn().mockResolvedValue('OK'),
            setex: vi.fn().mockResolvedValue('OK'),
            del: vi.fn().mockResolvedValue(1),
            keys: vi.fn().mockResolvedValue(['key1', 'key2']),
            exists: vi.fn().mockResolvedValue(1),
            publish: vi.fn().mockResolvedValue(1),
            lpush: vi.fn().mockResolvedValue(1),
            rpush: vi.fn().mockResolvedValue(1),
            hset: vi.fn().mockResolvedValue(1),
            sadd: vi.fn().mockResolvedValue(1),
            srem: vi.fn().mockResolvedValue(1),
            smembers: vi.fn().mockResolvedValue(['m1', 'm2']),
            quit: vi.fn().mockResolvedValue('OK'),
            status: 'ready',
        };

        (Redis as unknown as Mock).mockImplementation(() => mockRedisInstance);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create service without config service', () => {
            service = new RedisCacheService();
            expect(service).toBeDefined();
        });

        it('should create service with config service', () => {
            service = new RedisCacheService(mockConfigService);
            expect(service).toBeDefined();
        });
    });

    describe('onModuleInit', () => {
        it('should not connect when config service is not available', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            expect(Redis).not.toHaveBeenCalled();
            expect(service.isConnected()).toBe(false);
        });

        it('should not connect when Redis is not configured', async () => {
            mockConfigService = createMockConfigService(false);
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();

            expect(Redis).not.toHaveBeenCalled();
            expect(service.isConnected()).toBe(false);
        });

        it('should attempt to connect when Redis is configured', async () => {
            service = new RedisCacheService(mockConfigService);

            await service.onModuleInit();

            expect(Redis).toHaveBeenCalledWith(expect.objectContaining({
                host: 'localhost',
                port: 6379,
                password: 'testpass',
            }));
        });
    });

    describe('onModuleDestroy', () => {
        it('should not throw when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await expect(service.onModuleDestroy()).resolves.not.toThrow();
        });
    });

    describe('isConnected', () => {
        it('should return false when not initialized', () => {
            service = new RedisCacheService();
            expect(service.isConnected()).toBe(false);
        });

        it('should return false when config service is not available', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();
            expect(service.isConnected()).toBe(false);
        });
    });

    describe('get', () => {
        it('should return null when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            const result = await service.get('test-key');
            expect(result).toBeNull();
        });
    });

    describe('set', () => {
        it('should not set when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.set('test-key', 'test-value');
            expect(mockRedisInstance.set).not.toHaveBeenCalled();
        });

        it('should handle set with TTL when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.set('test-key', 'test-value', 300);
            expect(mockRedisInstance.setex).not.toHaveBeenCalled();
        });
    });

    describe('setex', () => {
        it('should not set when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.setex('test-key', 300, 'test-value');
            expect(mockRedisInstance.setex).not.toHaveBeenCalled();
        });
    });

    describe('del', () => {
        it('should not delete when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.del('test-key');
            expect(mockRedisInstance.del).not.toHaveBeenCalled();
        });
    });

    describe('delMany', () => {
        it('should not delete when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.delMany(['key1', 'key2']);
            expect(mockRedisInstance.del).not.toHaveBeenCalled();
        });

        it('should not delete when keys array is empty', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.delMany([]);
            expect(mockRedisInstance.del).not.toHaveBeenCalled();
        });
    });

    describe('keys', () => {
        it('should return empty array when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            const result = await service.keys('test:*');
            expect(result).toEqual([]);
        });
    });

    // Non-blocking SCAN alternative to `keys()`.
    describe('scan', () => {
        it('should return empty array when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            const result = await service.scan('test:*');
            expect(result).toEqual([]);
        });

        it('should walk the keyspace via cursor until it wraps to "0"', async () => {
            // Two-iteration SCAN: first call returns cursor "42" + two keys,
            // second call returns cursor "0" + one more key. The service
            // should concatenate and return all three keys.
            mockRedisInstance.scan = vi
                .fn()
                .mockResolvedValueOnce(['42', ['refresh-token-family:fam-a:hash1', 'refresh-token-family:fam-a:hash2']])
                .mockResolvedValueOnce(['0', ['refresh-token-family:fam-a:hash3']]);

            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();
            await new Promise((r) => setImmediate(r));

            const result = await service.scan('refresh-token-family:fam-a:*', { count: 200 });

            expect(result).toEqual([
                'refresh-token-family:fam-a:hash1',
                'refresh-token-family:fam-a:hash2',
                'refresh-token-family:fam-a:hash3',
            ]);
            expect(mockRedisInstance.scan).toHaveBeenCalledTimes(2);
            expect(mockRedisInstance.scan).toHaveBeenNthCalledWith(
                1,
                '0',
                'MATCH',
                'refresh-token-family:fam-a:*',
                'COUNT',
                200,
            );
            expect(mockRedisInstance.scan).toHaveBeenNthCalledWith(
                2,
                '42',
                'MATCH',
                'refresh-token-family:fam-a:*',
                'COUNT',
                200,
            );
        });

        it('should return [] and not throw when Redis scan errors', async () => {
            mockRedisInstance.scan = vi.fn().mockRejectedValueOnce(new Error('Redis scan error'));

            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();
            await new Promise((r) => setImmediate(r));

            const result = await service.scan('test:*');
            expect(result).toEqual([]);
        });
    });

    describe('exists', () => {
        it('should return false when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            const result = await service.exists('test-key');
            expect(result).toBe(false);
        });
    });

    describe('publish', () => {
        it('should not publish when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.publish('test-channel', 'test-message');
            expect(mockRedisInstance.publish).not.toHaveBeenCalled();
        });
    });

    describe('lpush', () => {
        it('should return 0 when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            const result = await service.lpush('test-list', 'test-value');
            expect(result).toBe(0);
        });

        it('should not call Redis lpush when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.lpush('test-list', 'test-value');
            expect(mockRedisInstance.lpush).not.toHaveBeenCalled();
        });

        /**
         * Helper: configure mocks so that the service becomes "connected"
         * after onModuleInit(). The Redis constructor must use a regular
         * function (not arrow) and the 'connect' event handler must fire.
         */
        async function initConnectedCacheService(): Promise<RedisCacheService> {
            // Use a regular function for the constructor (arrow functions can't be `new`-ed)
            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            // Auto-fire the 'connect' event handler so this.connected = true
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });

            const svc = new RedisCacheService(mockConfigService);
            await svc.onModuleInit();
            await new Promise((r) => setImmediate(r));
            return svc;
        }

        it('should call Redis lpush and return list length when connected', async () => {
            mockRedisInstance.lpush.mockResolvedValueOnce(5);
            service = await initConnectedCacheService();

            const result = await service.lpush('dramatiq:stt_batch', '{"message":"test"}');

            expect(mockRedisInstance.lpush).toHaveBeenCalledWith(
                'dramatiq:stt_batch',
                '{"message":"test"}',
            );
            expect(result).toBe(5);
        });

        it('should return 0 and not throw when Redis lpush errors', async () => {
            mockRedisInstance.lpush.mockRejectedValueOnce(new Error('Redis write error'));
            service = await initConnectedCacheService();

            const result = await service.lpush('test-list', 'value');

            expect(result).toBe(0);
        });

        it('should handle lpush with large JSON payload', async () => {
            const largePayload = JSON.stringify({ data: 'x'.repeat(50_000) });
            mockRedisInstance.lpush.mockResolvedValueOnce(1);
            service = await initConnectedCacheService();

            const result = await service.lpush('test-list', largePayload);

            expect(mockRedisInstance.lpush).toHaveBeenCalledWith('test-list', largePayload);
            expect(result).toBe(1);
        });
    });

    describe('rpush', () => {
        it('should return 0 when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            const result = await service.rpush('test-list', 'test-value');
            expect(result).toBe(0);
        });

        it('should not call Redis rpush when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.rpush('test-list', 'test-value');
            expect(mockRedisInstance.rpush).not.toHaveBeenCalled();
        });

        it('should call Redis rpush and return list length when connected', async () => {
            mockRedisInstance.rpush.mockResolvedValueOnce(3);

            // Reuse the connected init helper from lpush tests
            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();
            await new Promise((r) => setImmediate(r));

            const result = await service.rpush('dramatiq:stt_batch', 'msg-id-123');

            expect(mockRedisInstance.rpush).toHaveBeenCalledWith(
                'dramatiq:stt_batch',
                'msg-id-123',
            );
            expect(result).toBe(3);
        });

        it('should return 0 and not throw when Redis rpush errors', async () => {
            mockRedisInstance.rpush.mockRejectedValueOnce(new Error('Redis write error'));

            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();
            await new Promise((r) => setImmediate(r));

            const result = await service.rpush('test-list', 'value');
            expect(result).toBe(0);
        });
    });

    describe('hset', () => {
        it('should not call Redis hset when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            await service.hset('hash-key', 'field', 'value');
            expect(mockRedisInstance.hset).not.toHaveBeenCalled();
        });

        it('should call Redis hset when connected', async () => {
            mockRedisInstance.hset.mockResolvedValueOnce(1);

            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();
            await new Promise((r) => setImmediate(r));

            await service.hset('dramatiq:stt_batch.msgs', 'msg-id-123', '{"queue_name":"stt_batch"}');

            expect(mockRedisInstance.hset).toHaveBeenCalledWith(
                'dramatiq:stt_batch.msgs',
                'msg-id-123',
                '{"queue_name":"stt_batch"}',
            );
        });

        it('should not throw when Redis hset errors', async () => {
            mockRedisInstance.hset.mockRejectedValueOnce(new Error('Redis write error'));

            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();
            await new Promise((r) => setImmediate(r));

            await expect(service.hset('hash', 'field', 'value')).resolves.not.toThrow();
        });
    });

    // Live admin console — cross-instance active-session set ops.
    describe('set operations (sadd / srem / smembers)', () => {
        async function initConnected(): Promise<RedisCacheService> {
            (Redis as unknown as Mock).mockImplementation(function () {
                return mockRedisInstance;
            });
            mockRedisInstance.on = vi.fn().mockImplementation((event: string, cb: Function) => {
                if (event === 'connect') {
                    setImmediate(() => cb());
                }
                return mockRedisInstance;
            });
            const svc = new RedisCacheService(mockConfigService);
            await svc.onModuleInit();
            await new Promise((r) => setImmediate(r));
            return svc;
        }

        it('returns safe defaults when not connected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            expect(await service.sadd('s', 'm')).toBe(0);
            expect(await service.srem('s', 'm')).toBe(0);
            expect(await service.smembers('s')).toEqual([]);
            expect(mockRedisInstance.sadd).not.toHaveBeenCalled();
            expect(mockRedisInstance.srem).not.toHaveBeenCalled();
            expect(mockRedisInstance.smembers).not.toHaveBeenCalled();
        });

        it('delegates sadd / srem / smembers to Redis when connected', async () => {
            service = await initConnected();

            await service.sadd('live-doc:active:t1', 'c-1');
            await service.srem('live-doc:active:t1', 'c-1');
            const members = await service.smembers('live-doc:active:t1');

            expect(mockRedisInstance.sadd).toHaveBeenCalledWith('live-doc:active:t1', 'c-1');
            expect(mockRedisInstance.srem).toHaveBeenCalledWith('live-doc:active:t1', 'c-1');
            expect(members).toEqual(['m1', 'm2']);
        });

        it('returns safe defaults and does not throw when Redis set ops error', async () => {
            service = await initConnected();
            mockRedisInstance.sadd.mockRejectedValueOnce(new Error('boom'));
            mockRedisInstance.srem.mockRejectedValueOnce(new Error('boom'));
            mockRedisInstance.smembers.mockRejectedValueOnce(new Error('boom'));

            expect(await service.sadd('s', 'm')).toBe(0);
            expect(await service.srem('s', 'm')).toBe(0);
            expect(await service.smembers('s')).toEqual([]);
        });
    });

    describe('graceful fallback', () => {
        it('should return safe default values when disconnected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            // Verify each operation returns the correct "safe" fallback value
            // These are the values that won't break application logic

            // get() returns null - indicates cache miss
            const getValue = await service.get('key');
            expect(getValue).toBeNull();

            // keys() returns empty array - indicates no matches
            const keysValue = await service.keys('*');
            expect(keysValue).toEqual([]);
            expect(Array.isArray(keysValue)).toBe(true);

            // exists() returns false - indicates key doesn't exist
            const existsValue = await service.exists('key');
            expect(existsValue).toBe(false);
        });

        it('should not throw errors when performing write operations while disconnected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            // Write operations should complete without throwing
            // This prevents application crashes due to cache unavailability
            await expect(service.set('key', 'value')).resolves.not.toThrow();
            await expect(service.setex('key', 300, 'value')).resolves.not.toThrow();
            await expect(service.del('key')).resolves.not.toThrow();
            await expect(service.delMany(['key1', 'key2'])).resolves.not.toThrow();
            await expect(service.publish('channel', 'message')).resolves.not.toThrow();
            await expect(service.lpush('list', 'value')).resolves.not.toThrow();
            await expect(service.rpush('list', 'value')).resolves.not.toThrow();
            await expect(service.hset('hash', 'field', 'value')).resolves.not.toThrow();
        });

        it('should not call Redis methods when disconnected', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            // Perform operations
            await service.get('key');
            await service.set('key', 'value');
            await service.del('key');

            // Verify Redis was never called (since we're disconnected)
            expect(mockRedisInstance.get).not.toHaveBeenCalled();
            expect(mockRedisInstance.set).not.toHaveBeenCalled();
            expect(mockRedisInstance.del).not.toHaveBeenCalled();
        });
    });

    describe('connection state', () => {
        it('should report disconnected when no config service provided', async () => {
            service = new RedisCacheService();
            await service.onModuleInit();

            expect(service.isConnected()).toBe(false);
        });

        it('should report disconnected when Redis is not configured', async () => {
            mockConfigService = createMockConfigService(false);
            service = new RedisCacheService(mockConfigService);
            await service.onModuleInit();

            expect(service.isConnected()).toBe(false);
        });
    });
});
