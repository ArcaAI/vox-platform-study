import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApiKeyRateLimiter } from '../apikey-rate-limiter.service';

const mockRedis = {
  isConnected: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
};

describe('ApiKeyRateLimiter', () => {
  let limiter: ApiKeyRateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    limiter = new ApiKeyRateLimiter(mockRedis as any);
  });

  describe('checkRateLimit', () => {
    it('should allow request when under limit', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.incr.mockResolvedValue(5);

      const result = await limiter.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(995);
      expect(result.limit).toBe(1000);
      expect(result.resetAt).toBeInstanceOf(Date);
    });

    it('should deny request when at limit', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.incr.mockResolvedValue(1001);

      const result = await limiter.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should deny request when over limit', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.incr.mockResolvedValue(1500);

      const result = await limiter.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should set expiry on first request in window', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.incr.mockResolvedValue(1);

      await limiter.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(mockRedis.expire).toHaveBeenCalledTimes(1);
    });

    it('should not set expiry on subsequent requests', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.incr.mockResolvedValue(50);

      await limiter.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('should allow all requests when limit is 0 (unlimited)', async () => {
      const result = await limiter.checkRateLimit('key-1', 'tenant-1', 0);

      expect(result.allowed).toBe(true);
      expect(mockRedis.incr).not.toHaveBeenCalled();
    });

    it('should allow all requests when limit is negative', async () => {
      const result = await limiter.checkRateLimit('key-1', 'tenant-1', -1);

      expect(result.allowed).toBe(true);
    });

    it('should allow requests when Redis is unavailable', async () => {
      mockRedis.isConnected.mockReturnValue(false);

      const result = await limiter.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1000);
    });

    it('should allow requests when Redis throws error', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.incr.mockRejectedValue(new Error('Redis connection lost'));

      const result = await limiter.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(result.allowed).toBe(true);
    });

    it('should use tenant-scoped Redis keys', async () => {
      mockRedis.isConnected.mockReturnValue(true);
      mockRedis.incr.mockResolvedValue(1);

      await limiter.checkRateLimit('key-1', 'tenant-abc', 1000);

      const incrArg = mockRedis.incr.mock.calls[0][0];
      expect(incrArg).toContain('tenant-abc');
      expect(incrArg).toContain('key-1');
    });

    it('should handle no Redis service (constructed without Redis)', async () => {
      const limiterNoRedis = new ApiKeyRateLimiter(undefined as any);

      const result = await limiterNoRedis.checkRateLimit('key-1', 'tenant-1', 1000);

      expect(result.allowed).toBe(true);
    });
  });
});
