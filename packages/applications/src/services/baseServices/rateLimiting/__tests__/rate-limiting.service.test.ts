/**
 * RateLimitingService Unit Tests
 *
 * Tests for the Redis-based rate limiting service using sliding window algorithm.
 *
 * Testing Strategy:
 * - Mock Redis (external boundary) to avoid network calls
 * - Verify the sliding window algorithm produces correct results
 * - Test actual rate limit decisions (allowed/denied), not just mock calls
 * - Verify fail-open behavior on Redis errors
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { RateLimitingService, RateLimitResult } from '../rate-limiting.service';
import type { RateLimitOptions } from '../../../../decorators/gateway-decorators';

/**
 * Complete Redis pipeline mock matching ioredis interface.
 * Returns 'this' for chaining, exec() returns results array.
 */
const mockPipeline = {
    get: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn(),
};

/**
 * Complete Redis mock matching ioredis interface.
 */
const mockRedis = {
    pipeline: vi.fn(() => mockPipeline),
    keys: vi.fn(),
    del: vi.fn(),
};

describe('RateLimitingService', () => {
    let service: RateLimitingService;

    const defaultOptions: RateLimitOptions = {
        requests: 100,
        windowMs: 60000, // 1 minute
    };

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

        service = new RateLimitingService();
        service.setRedisInstance(mockRedis as any);

        // Default pipeline execution result
        mockPipeline.exec.mockResolvedValue([
            [null, '10'], // current window count
            [null, '5'],  // previous window count
            [null, '11'], // new count after incr
            [null, 1],    // expire result
        ]);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('should create service instance', () => {
            const newService = new RateLimitingService();
            expect(newService).toBeDefined();
        });
    });

    describe('setRedisInstance', () => {
        it('should set Redis instance', () => {
            const newService = new RateLimitingService();
            newService.setRedisInstance(mockRedis as any);
            // Service should work after setting Redis
            expect(newService).toBeDefined();
        });
    });

    describe('checkRateLimit', () => {
        it('should allow request when total hits are below limit', async () => {
            // Simulate: current window has 10 hits, previous had 5
            // At start of window (0% progress), sliding window = 10 + 5*1.0 = 15 hits
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],  // current window count
                [null, '5'],   // previous window count
                [null, '11'],  // new count after increment
                [null, 1],     // expire result
            ]);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // Verify the actual decision
            expect(result.allowed).toBe(true);
            // Verify remaining is calculated correctly (100 - ~15 = ~85)
            expect(result.remaining).toBeGreaterThan(80);
            expect(result.remaining).toBeLessThanOrEqual(100);
        });

        it('should deny request when sliding window total exceeds limit', async () => {
            // Simulate: current=100, previous=50 -> at 0% progress, total = 100 + 50 = 150 > 100
            mockPipeline.exec.mockResolvedValue([
                [null, '100'],
                [null, '50'],
                [null, '101'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // Verify the actual rate limit decision
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
            // Verify total hits reflects the sliding window calculation
            expect(result.totalHits).toBeGreaterThanOrEqual(100);
        });

        it('should calculate sliding window with time-weighted previous window', async () => {
            // Set time to 30 seconds into a 60-second window (50% progress)
            vi.setSystemTime(new Date('2024-01-01T12:00:30.000Z'));

            // current=40, previous=60
            // At 50% progress: sliding total = 40 + 60 * 0.5 = 70 hits
            mockPipeline.exec.mockResolvedValue([
                [null, '40'],
                [null, '60'],
                [null, '41'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // Verify sliding window calculation is approximately correct
            // Expected: ~70 hits (40 current + 30 from previous)
            expect(result.totalHits).toBeGreaterThanOrEqual(65);
            expect(result.totalHits).toBeLessThanOrEqual(75);
            expect(result.allowed).toBe(true); // 70 < 100
        });

        it('should return accurate remaining requests count', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '25'],
                [null, '25'],
                [null, '26'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // At 0% progress: total = 25 + 25 = 50, remaining = 100 - 50 = 50
            expect(result.remaining).toBeGreaterThanOrEqual(45);
            expect(result.remaining).toBeLessThanOrEqual(55);
        });

        it('should return reset time at end of current window', async () => {
            const result = await service.checkRateLimit('user:123', defaultOptions);

            expect(result.resetTime).toBeInstanceOf(Date);
            // Reset time should be within the window duration from now
            const expectedResetTime = Date.now() + defaultOptions.windowMs;
            expect(result.resetTime.getTime()).toBeLessThanOrEqual(expectedResetTime);
            expect(result.resetTime.getTime()).toBeGreaterThanOrEqual(Date.now());
        });

        it('should fail open and allow request when Redis pipeline returns null', async () => {
            mockPipeline.exec.mockResolvedValue(null);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // Fail-open behavior: allow the request
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(defaultOptions.requests);
            expect(result.totalHits).toBe(0);
        });

        it('should fail open and allow request when Redis throws error', async () => {
            mockPipeline.exec.mockRejectedValue(new Error('Redis connection error'));

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // Fail-open: don't block users due to infrastructure issues
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(defaultOptions.requests);
            expect(result.totalHits).toBe(0);
        });

        it('should treat null count values as zero', async () => {
            // First request ever - no existing counts
            mockPipeline.exec.mockResolvedValue([
                [null, null],  // no current window data
                [null, null],  // no previous window data
                [null, '1'],   // first increment
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            expect(result.allowed).toBe(true);
            expect(result.totalHits).toBeLessThanOrEqual(1);
        });

        it('should increment counter even when checking rate limit', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],  // This shows the counter was incremented
                [null, 1],
            ]);

            await service.checkRateLimit('user:123', defaultOptions);

            // Verify incr was called (counter should be incremented)
            expect(mockPipeline.incr).toHaveBeenCalled();
        });
    });

    describe('checkMultipleRateLimits', () => {
        const identifiers = {
            userId: 'user-123',
            ip: '192.168.1.1',
            apiKey: 'api-key-456',
            endpoint: '/api/users',
        };

        const limits = {
            perUser: { requests: 100, windowMs: 60000 },
            perIP: { requests: 50, windowMs: 60000 },
            perApiKey: { requests: 200, windowMs: 60000 },
            perEndpoint: { requests: 1000, windowMs: 60000 },
            global: { requests: 10000, windowMs: 60000 },
        };

        it('should check all rate limits', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],
                [null, 1],
            ]);

            const result = await service.checkMultipleRateLimits(identifiers, limits);

            expect(result).toBeDefined();
            expect(result.allowed).toBeDefined();
        });

        it('should return most restrictive result', async () => {
            // First call returns allowed
            mockPipeline.exec
                .mockResolvedValueOnce([
                    [null, '10'],
                    [null, '5'],
                    [null, '11'],
                    [null, 1],
                ])
                // Second call (per-IP) returns denied
                .mockResolvedValueOnce([
                    [null, '50'],
                    [null, '30'],
                    [null, '51'],
                    [null, 1],
                ])
                .mockResolvedValue([
                    [null, '10'],
                    [null, '5'],
                    [null, '11'],
                    [null, 1],
                ]);

            const result = await service.checkMultipleRateLimits(identifiers, limits);

            // Should return the denied result
            expect(result.allowed).toBe(false);
        });

        it('should skip checks for missing identifiers', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],
                [null, 1],
            ]);

            const partialIdentifiers = {
                ip: '192.168.1.1',
            };

            const result = await service.checkMultipleRateLimits(partialIdentifiers, {
                perIP: { requests: 50, windowMs: 60000 },
            });

            expect(result.allowed).toBe(true);
        });

        it('should skip checks for missing limit configurations', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],
                [null, 1],
            ]);

            const result = await service.checkMultipleRateLimits(identifiers, {
                perIP: { requests: 50, windowMs: 60000 },
            });

            expect(result.allowed).toBe(true);
        });

        it('should fail open on error', async () => {
            mockPipeline.exec.mockRejectedValue(new Error('Redis error'));

            const result = await service.checkMultipleRateLimits(identifiers, limits);

            expect(result.allowed).toBe(true);
            // The remaining value depends on which limit category fails first
            expect(result.remaining).toBeGreaterThanOrEqual(0);
        });

        it('should check global rate limit', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],
                [null, 1],
            ]);

            await service.checkMultipleRateLimits(
                { ip: '192.168.1.1' },
                { global: { requests: 1000, windowMs: 60000 } }
            );

            // Should have made calls for global limit
            expect(mockRedis.pipeline).toHaveBeenCalled();
        });
    });

    describe('resetRateLimit', () => {
        it('should delete all keys matching pattern', async () => {
            mockRedis.keys.mockResolvedValue([
                'rate_limit:user:123:1000',
                'rate_limit:user:123:999',
            ]);
            mockRedis.del.mockResolvedValue(2);

            const result = await service.resetRateLimit('user:123');

            expect(result).toBe(true);
            expect(mockRedis.keys).toHaveBeenCalledWith('rate_limit:user:123:*');
            expect(mockRedis.del).toHaveBeenCalledWith(
                'rate_limit:user:123:1000',
                'rate_limit:user:123:999'
            );
        });

        it('should return true when no keys found', async () => {
            mockRedis.keys.mockResolvedValue([]);

            const result = await service.resetRateLimit('user:123');

            expect(result).toBe(true);
            expect(mockRedis.del).not.toHaveBeenCalled();
        });

        it('should return false on error', async () => {
            mockRedis.keys.mockRejectedValue(new Error('Redis error'));

            const result = await service.resetRateLimit('user:123');

            expect(result).toBe(false);
        });
    });

    describe('getRateLimitStatus', () => {
        it('should return current status without incrementing', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '50'],
                [null, '30'],
            ]);

            const result = await service.getRateLimitStatus('user:123', defaultOptions);

            expect(result.allowed).toBe(true);
            expect(result.totalHits).toBeGreaterThan(0);
            // Should only call get, not incr
            expect(mockPipeline.incr).not.toHaveBeenCalled();
        });

        it('should calculate sliding window correctly', async () => {
            vi.setSystemTime(new Date('2024-01-01T12:00:30.000Z'));

            mockPipeline.exec.mockResolvedValue([
                [null, '40'],
                [null, '60'],
            ]);

            const result = await service.getRateLimitStatus('user:123', defaultOptions);

            // Should use sliding window calculation
            expect(result.totalHits).toBeGreaterThan(40);
        });

        it('should return allowed=false when at limit', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '100'],
                [null, '50'],
            ]);

            const result = await service.getRateLimitStatus('user:123', defaultOptions);

            expect(result.allowed).toBe(false);
        });

        it('should handle Redis pipeline failure', async () => {
            mockPipeline.exec.mockResolvedValue(null);

            const result = await service.getRateLimitStatus('user:123', defaultOptions);

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(defaultOptions.requests);
        });

        it('should fail open on error', async () => {
            mockPipeline.exec.mockRejectedValue(new Error('Redis error'));

            const result = await service.getRateLimitStatus('user:123', defaultOptions);

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(defaultOptions.requests);
            expect(result.totalHits).toBe(0);
        });

        it('should handle missing count values', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, null],
                [null, null],
            ]);

            const result = await service.getRateLimitStatus('user:123', defaultOptions);

            expect(result.allowed).toBe(true);
            expect(result.totalHits).toBe(0);
        });
    });

    describe('edge cases', () => {
        it('should deny all requests when limit is zero', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '0'],
                [null, '0'],
                [null, '1'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', {
                requests: 0,
                windowMs: 60000,
            });

            // Zero limit means no requests allowed
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });

        it('should handle very small window (1 second)', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', {
                requests: 100,
                windowMs: 1000,
            });

            expect(result).toBeDefined();
            expect(result.resetTime.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
        });

        it('should handle very large window (24 hours)', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', {
                requests: 100,
                windowMs: 86400000,
            });

            expect(result).toBeDefined();
            expect(result.allowed).toBe(true);
        });

        it('should handle special characters in identifier key', async () => {
            let capturedKey: string | undefined;
            mockPipeline.get.mockImplementation(function(this: any, key: string) {
                capturedKey = key;
                return this;
            });
            mockPipeline.exec.mockResolvedValue([
                [null, '10'],
                [null, '5'],
                [null, '11'],
                [null, 1],
            ]);

            await service.checkRateLimit('user:test@example.com', defaultOptions);

            // Verify the key was used correctly (contains the email)
            expect(capturedKey).toContain('test@example.com');
        });

        it('should handle high volume of requests near limit boundary', async () => {
            // Simulate exactly at the limit
            mockPipeline.exec.mockResolvedValue([
                [null, '99'],
                [null, '0'],
                [null, '100'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // At exactly 100 requests with limit of 100, should still be allowed
            // (the 100th request is the last allowed one)
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(0);
        });

        it('should handle first request ever (no existing data)', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, null],
                [null, null],
                [null, '1'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('new-user:456', defaultOptions);

            expect(result.allowed).toBe(true);
            expect(result.totalHits).toBeLessThanOrEqual(1);
            expect(result.remaining).toBeGreaterThanOrEqual(99);
        });

        it('should handle Redis returning string "0" vs null', async () => {
            mockPipeline.exec.mockResolvedValue([
                [null, '0'],
                [null, '0'],
                [null, '1'],
                [null, 1],
            ]);

            const result = await service.checkRateLimit('user:123', defaultOptions);

            // String "0" should be parsed as 0, not treated as falsy
            expect(result.totalHits).toBeLessThanOrEqual(1);
        });
    });

    describe('concurrent request handling', () => {
        it('should handle rapid sequential requests', async () => {
            let callCount = 0;
            mockPipeline.exec.mockImplementation(async () => {
                callCount++;
                return [
                    [null, String(callCount * 10)],
                    [null, '5'],
                    [null, String(callCount * 10 + 1)],
                    [null, 1],
                ];
            });

            // Simulate 5 rapid requests
            const results = await Promise.all([
                service.checkRateLimit('user:123', defaultOptions),
                service.checkRateLimit('user:123', defaultOptions),
                service.checkRateLimit('user:123', defaultOptions),
                service.checkRateLimit('user:123', defaultOptions),
                service.checkRateLimit('user:123', defaultOptions),
            ]);

            // All should complete without error
            expect(results).toHaveLength(5);
            results.forEach(result => {
                expect(result).toHaveProperty('allowed');
                expect(result).toHaveProperty('remaining');
            });
        });
    });
});
