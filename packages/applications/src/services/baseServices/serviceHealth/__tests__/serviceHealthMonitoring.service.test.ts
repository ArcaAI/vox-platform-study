/**
 * ServiceHealthMonitoringService Unit Tests
 *
 * Tests the microservice health monitoring service that tracks heartbeats,
 * uptime, and session counts for the real downstream services
 * (TEXT, NLP, STT v2, Guardrail, Harness).
 *
 * Mocking strategy: We mock ioredis at module level so the constructor
 * returns a controllable mock instance. We also mock global fetch.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Create the mock Redis instance BEFORE importing the service
const mockRedisInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  quit: vi.fn().mockResolvedValue(undefined),
  lpush: vi.fn().mockResolvedValue(1),
  ltrim: vi.fn().mockResolvedValue('OK'),
  expire: vi.fn().mockResolvedValue(1),
  lrange: vi.fn().mockResolvedValue([]),
};

// Mock ioredis at the module level
// Must use a class/function (not arrow) since the service calls `new Redis(...)`
vi.mock('ioredis', () => ({
  default: function MockRedis() {
    return mockRedisInstance;
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Now import the service (after mocks are set up)
import { ServiceHealthMonitoringService } from '../serviceHealthMonitoring.service';

// Mock ConfigService
const createMockConfigService = () => ({
  getRedisConfig: vi.fn().mockReturnValue({
    host: 'localhost',
    port: 6379,
    password: undefined,
  }),
  get: vi.fn(),
  getOrThrow: vi.fn(),
});

// Helper to create heartbeat JSON strings
function createHeartbeatJson(status: 'up' | 'down', responseTime = 50): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    status,
    responseTime,
  });
}

describe('ServiceHealthMonitoringService', () => {
  let service: ServiceHealthMonitoringService;
  let mockConfigService: ReturnType<typeof createMockConfigService>;

  beforeEach(async () => {
    // Reset all mock implementations to defaults
    mockRedisInstance.connect.mockReset().mockResolvedValue(undefined);
    mockRedisInstance.quit.mockReset().mockResolvedValue(undefined);
    mockRedisInstance.lpush.mockReset().mockResolvedValue(1);
    mockRedisInstance.ltrim.mockReset().mockResolvedValue('OK');
    mockRedisInstance.expire.mockReset().mockResolvedValue(1);
    mockRedisInstance.lrange.mockReset().mockResolvedValue([]);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });

    mockConfigService = createMockConfigService();
    service = new ServiceHealthMonitoringService(mockConfigService as any);
    await service.onModuleInit();

    // Clear init-related mock calls so tests start clean
    mockRedisInstance.lpush.mockClear();
    mockRedisInstance.ltrim.mockClear();
    mockRedisInstance.expire.mockClear();
    mockRedisInstance.lrange.mockClear();
    mockFetch.mockReset();
  });

  // ========================================================================
  // getUptime()
  // ========================================================================

  describe('getUptime', () => {
    it('should return uptime data for all 6 monitored services', async () => {
      mockRedisInstance.lrange.mockResolvedValue([]);

      const result = await service.getUptime();

      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('refreshedAt');
      expect(Object.keys(result.services)).toHaveLength(6);
      expect(result.services).toHaveProperty('text');
      expect(result.services).toHaveProperty('nlp');
      expect(result.services).toHaveProperty('stt');
      expect(result.services).toHaveProperty('tts');
      expect(result.services).toHaveProperty('guardrail');
      expect(result.services).toHaveProperty('harness');
    });

    it('should return unknown status when no heartbeats exist', async () => {
      mockRedisInstance.lrange.mockResolvedValue([]);

      const result = await service.getUptime();

      expect(result.services['guardrail'].status).toBe('unknown');
      expect(result.services['guardrail'].uptime).toBe(0);
      expect(result.services['guardrail'].responseTime).toBe(0);
    });

    it('should return healthy status when all recent heartbeats are up', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 100), createHeartbeatJson('up', 80), createHeartbeatJson('up', 90)]);

      const result = await service.getUptime();

      expect(result.services['guardrail'].status).toBe('healthy');
      expect(result.services['guardrail'].uptime).toBe(100);
    });

    it('should return down status when all recent heartbeats are down', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('down', 0), createHeartbeatJson('down', 0), createHeartbeatJson('down', 0)]);

      const result = await service.getUptime();

      expect(result.services['guardrail'].status).toBe('down');
      expect(result.services['guardrail'].uptime).toBe(0);
    });

    it('should return degraded status when heartbeats are mixed', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 100), createHeartbeatJson('down', 0), createHeartbeatJson('up', 90)]);

      const result = await service.getUptime();

      expect(result.services['guardrail'].status).toBe('degraded');
    });

    it('should calculate uptime percentage correctly', async () => {
      // 2 up out of 4 = 50%
      mockRedisInstance.lrange.mockResolvedValue([
        createHeartbeatJson('up', 100),
        createHeartbeatJson('down', 0),
        createHeartbeatJson('up', 90),
        createHeartbeatJson('down', 0),
      ]);

      const result = await service.getUptime();

      expect(result.services['guardrail'].uptime).toBe(50);
    });

    it('should include refreshedAt as an ISO timestamp', async () => {
      mockRedisInstance.lrange.mockResolvedValue([]);

      const result = await service.getUptime();

      expect(result.refreshedAt).toBeDefined();
      expect(new Date(result.refreshedAt).toISOString()).toBe(result.refreshedAt);
    });
  });

  // ========================================================================
  // getServiceUptime()
  // ========================================================================

  describe('getServiceUptime', () => {
    it('should return uptime for a valid service name', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 50)]);

      const result = await service.getServiceUptime('guardrail');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('healthy');
      expect(result!.uptime).toBe(100);
    });

    it('should return null for an unknown service name', async () => {
      const result = await service.getServiceUptime('Unknown Service');

      expect(result).toBeNull();
    });

    it('should include heartbeat history in the response', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 50), createHeartbeatJson('up', 60)]);

      const result = await service.getServiceUptime('guardrail');

      expect(result!.heartbeats).toHaveLength(2);
      expect(result!.heartbeats[0].status).toBe('up');
    });

    it('should return correct response time from latest heartbeat', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 42), createHeartbeatJson('up', 100)]);

      const result = await service.getServiceUptime('guardrail');

      expect(result!.responseTime).toBe(42);
    });
  });

  // ========================================================================
  // getHeartbeatHistory()
  // ========================================================================

  describe('getHeartbeatHistory', () => {
    it('should return parsed heartbeat records from Redis', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 100), createHeartbeatJson('down', 0)]);

      const result = await service.getHeartbeatHistory('guardrail');

      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('timestamp');
      expect(result[0]).toHaveProperty('status');
      expect(result[0]).toHaveProperty('responseTime');
      expect(result[0].status).toBe('up');
      expect(result[1].status).toBe('down');
    });

    it('should return empty array when Redis lrange fails', async () => {
      mockRedisInstance.lrange.mockRejectedValue(new Error('Redis timeout'));

      const result = await service.getHeartbeatHistory('guardrail');

      expect(result).toEqual([]);
    });

    it('should return empty array when Redis is unavailable', async () => {
      mockRedisInstance.connect.mockRejectedValue(new Error('Connection refused'));
      const mockConfig = createMockConfigService();
      const freshService = new ServiceHealthMonitoringService(mockConfig as any);
      await freshService.onModuleInit();

      const result = await freshService.getHeartbeatHistory('guardrail');

      expect(result).toEqual([]);
    });
  });

  // ========================================================================
  // getSessionCounts()
  // ========================================================================

  describe('getSessionCounts', () => {
    it('should return session counts with correct structure', async () => {
      const result = await service.getSessionCounts();

      expect(result).toHaveProperty('services');
      expect(result).toHaveProperty('totalUsers');
      expect(result).toHaveProperty('refreshedAt');
      expect(result.services.text.active).toBe(0);
      expect(result.services.guardrail.active).toBe(0);
      expect(result.totalUsers).toBe(0);
    });

    // Sessions cover the real downstream services (text, stt, nlp,
    // guardrail, harness), matching the uptime/health surfaces. The
    // counts stay static zeros (no per-service polling — see no-fetch test).
    it('should include tts, stt, nlp, guardrail and harness session counts', async () => {
      const result = await service.getSessionCounts();

      expect(result.services.tts.active).toBe(0);
      expect(result.services.stt.active).toBe(0);
      expect(result.services.nlp.active).toBe(0);
      expect(result.services.guardrail.active).toBe(0);
      expect(result.services.harness.active).toBe(0);
    });

    it('should not poll downstream services for session counts (no fetch)', async () => {
      await service.getSessionCounts();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should include a valid ISO refreshedAt timestamp', async () => {
      const result = await service.getSessionCounts();

      expect(result.refreshedAt).toBeDefined();
      expect(new Date(result.refreshedAt).toISOString()).toBe(result.refreshedAt);
    });
  });

  // ========================================================================
  // performHealthChecks()
  // ========================================================================

  describe('performHealthChecks', () => {
    it('should call health endpoints for all configured services', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.performHealthChecks();

      expect(mockFetch).toHaveBeenCalledTimes(6);
    });

    // Guardrail mounts its health router under `/api`; the other services
    // use `/api/v1/health` (mirrors the gateway health controller).
    it('should fetch all service health endpoints at /api(/v1)/health', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.performHealthChecks();

      const calledUrls = mockFetch.mock.calls.map((c: any[]) => c[0] as string);
      for (const url of calledUrls) {
        expect(url).toMatch(/^http:\/\/localhost:\d+\/api\/(v1\/)?health$/);
      }
    });

    it('should store heartbeat as up when health check succeeds', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.performHealthChecks();

      expect(mockRedisInstance.lpush).toHaveBeenCalled();
      const storedData = JSON.parse(mockRedisInstance.lpush.mock.calls[0][1]);
      expect(storedData.status).toBe('up');
    });

    it('should store heartbeat as down when health check fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      await service.performHealthChecks();

      expect(mockRedisInstance.lpush).toHaveBeenCalled();
      const storedData = JSON.parse(mockRedisInstance.lpush.mock.calls[0][1]);
      expect(storedData.status).toBe('down');
    });

    it('should store heartbeat as down when health check returns non-ok', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });

      await service.performHealthChecks();

      expect(mockRedisInstance.lpush).toHaveBeenCalled();
      const storedData = JSON.parse(mockRedisInstance.lpush.mock.calls[0][1]);
      expect(storedData.status).toBe('down');
    });

    it('should include responseTime in stored heartbeat', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.performHealthChecks();

      const storedData = JSON.parse(mockRedisInstance.lpush.mock.calls[0][1]);
      expect(storedData).toHaveProperty('responseTime');
      expect(typeof storedData.responseTime).toBe('number');
      expect(storedData.responseTime).toBeGreaterThanOrEqual(0);
    });

    it('should include ISO timestamp in stored heartbeat', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.performHealthChecks();

      const storedData = JSON.parse(mockRedisInstance.lpush.mock.calls[0][1]);
      expect(storedData).toHaveProperty('timestamp');
      expect(new Date(storedData.timestamp).toISOString()).toBe(storedData.timestamp);
    });

    it('should trim heartbeat list to configured size', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.performHealthChecks();

      expect(mockRedisInstance.ltrim).toHaveBeenCalled();
      expect(mockRedisInstance.ltrim.mock.calls[0][2]).toBe(89);
    });

    it('should set TTL on heartbeat key', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      await service.performHealthChecks();

      expect(mockRedisInstance.expire).toHaveBeenCalled();
      expect(mockRedisInstance.expire.mock.calls[0][1]).toBe(86400);
    });

    it('should not throw when Redis lpush fails during heartbeat storage', async () => {
      mockFetch.mockResolvedValue({ ok: true });
      mockRedisInstance.lpush.mockRejectedValue(new Error('Redis write error'));

      await expect(service.performHealthChecks()).resolves.not.toThrow();
    });
  });

  // ========================================================================
  // lifecycle
  // ========================================================================

  describe('lifecycle', () => {
    it('should initialize Redis connection on module init', () => {
      expect(mockRedisInstance.connect).toHaveBeenCalled();
    });

    it('should read Redis config from ConfigService', () => {
      expect(mockConfigService.getRedisConfig).toHaveBeenCalled();
    });

    it('should quit Redis connection on module destroy', async () => {
      await service.onModuleDestroy();

      expect(mockRedisInstance.quit).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // Status determination edge cases
  // ========================================================================

  describe('status determination edge cases', () => {
    it('should use only the 3 most recent heartbeats for status', async () => {
      mockRedisInstance.lrange.mockResolvedValue([
        createHeartbeatJson('up', 50),
        createHeartbeatJson('up', 50),
        createHeartbeatJson('up', 50),
        createHeartbeatJson('down', 0),
        createHeartbeatJson('down', 0),
        createHeartbeatJson('down', 0),
      ]);

      const result = await service.getServiceUptime('guardrail');

      expect(result!.status).toBe('healthy');
      expect(result!.uptime).toBe(50);
    });

    it('should handle single heartbeat correctly', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('down', 0)]);

      const result = await service.getServiceUptime('guardrail');

      expect(result!.status).toBe('down');
      expect(result!.uptime).toBe(0);
    });

    it('should handle exactly 2 heartbeats (less than window of 3)', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 50), createHeartbeatJson('down', 0)]);

      const result = await service.getServiceUptime('guardrail');

      expect(result!.status).toBe('degraded');
      expect(result!.uptime).toBe(50);
    });

    it('should round uptime to 2 decimal places', async () => {
      mockRedisInstance.lrange.mockResolvedValue([createHeartbeatJson('up', 50), createHeartbeatJson('up', 50), createHeartbeatJson('down', 0)]);

      const result = await service.getServiceUptime('guardrail');

      // 2/3 = 66.666... should round to 66.67
      expect(result!.uptime).toBe(66.67);
    });

    it('should return 100% uptime when all heartbeats are up', async () => {
      mockRedisInstance.lrange.mockResolvedValue([
        createHeartbeatJson('up', 50),
        createHeartbeatJson('up', 60),
        createHeartbeatJson('up', 40),
        createHeartbeatJson('up', 55),
      ]);

      const result = await service.getServiceUptime('guardrail');

      expect(result!.uptime).toBe(100);
      expect(result!.status).toBe('healthy');
    });
  });

  // ========================================================================
  // Redis unavailability edge cases
  // ========================================================================

  describe('Redis unavailability', () => {
    it('should not throw during health checks when Redis is down', async () => {
      mockRedisInstance.lpush.mockRejectedValue(new Error('ECONNREFUSED'));
      mockFetch.mockResolvedValue({ ok: true });

      await expect(service.performHealthChecks()).resolves.not.toThrow();
    });

    it('should return empty heartbeats when Redis is null', async () => {
      mockRedisInstance.connect.mockRejectedValue(new Error('Connection refused'));
      const mockConfig = createMockConfigService();
      const freshService = new ServiceHealthMonitoringService(mockConfig as any);
      await freshService.onModuleInit();

      const result = await freshService.getUptime();

      for (const svc of Object.values(result.services)) {
        expect(svc.heartbeats).toEqual([]);
        expect(svc.status).toBe('unknown');
      }
    });

    it('should handle onModuleDestroy when Redis was never connected', async () => {
      mockRedisInstance.connect.mockRejectedValue(new Error('Connection refused'));
      const mockConfig = createMockConfigService();
      const freshService = new ServiceHealthMonitoringService(mockConfig as any);
      await freshService.onModuleInit();

      await expect(freshService.onModuleDestroy()).resolves.not.toThrow();
    });
  });
});
