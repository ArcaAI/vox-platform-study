/**
 * HealthCheckService Unit Tests
 *
 * Tests for the health check service that provides system health status.
 *
 * Testing Strategy:
 * - Test actual health check behavior and result structure
 * - Verify health indicators are properly executed
 * - Test threshold configuration affects health check behavior
 * - Ensure error handling returns proper health status
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { HealthCheckService } from '../health-check.service';
import {
  HealthCheckService as TerminusHealthCheckService,
  HealthIndicatorResult,
  HealthCheckResult,
  HttpHealthIndicator,
  DiskHealthIndicator,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { IAppSettingsService } from '../../_meta/appSettings';

// Mock @nestjs/terminus - external health check framework
vi.mock('@nestjs/terminus', () => ({
  HealthCheckService: vi.fn(),
  HttpHealthIndicator: vi.fn(),
  DiskHealthIndicator: vi.fn(),
  MemoryHealthIndicator: vi.fn(),
  HealthCheck: () => (target: any, propertyKey: string, descriptor: PropertyDescriptor) => descriptor,
  // Base class other indicators in the import graph extend at module-eval
  // time (e.g. SecretsHealthIndicator, reached via the appSettings barrel's
  // module imports) — the mock must define it or those imports crash.
  HealthIndicator: class {
    protected getStatus(key: string, isHealthy: boolean, data?: Record<string, unknown>) {
      return { [key]: { status: isHealthy ? 'up' : 'down', ...data } };
    }
  },
  HealthCheckError: class extends Error {
    constructor(
      message: string,
      public readonly causes: unknown,
    ) {
      super(message);
    }
  },
}));

describe('HealthCheckService', () => {
  let service: HealthCheckService;
  let mockTerminusHealthService: {
    check: Mock;
  };
  let mockHttpHealthIndicator: {
    pingCheck: Mock;
  };
  let mockDiskHealthIndicator: {
    checkStorage: Mock;
  };
  let mockMemoryHealthIndicator: {
    checkHeap: Mock;
    checkRSS: Mock;
  };
  let mockAppSettingsService: {
    getValueWithDefault: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockTerminusHealthService = {
      check: vi.fn().mockResolvedValue({
        status: 'ok',
        info: {},
        error: {},
        details: {},
      }),
    };

    mockHttpHealthIndicator = {
      pingCheck: vi.fn().mockResolvedValue({ api: { status: 'up' } }),
    };

    mockDiskHealthIndicator = {
      checkStorage: vi.fn().mockResolvedValue({ storage: { status: 'up' } }),
    };

    mockMemoryHealthIndicator = {
      checkHeap: vi.fn().mockResolvedValue({ memory_heap: { status: 'up' } }),
      checkRSS: vi.fn().mockResolvedValue({ memory_rss: { status: 'up' } }),
    };

    mockAppSettingsService = {
      getValueWithDefault: vi.fn().mockImplementation((key: string, defaultValue: any) => {
        const settings: Record<string, any> = {
          'healthCheck.endpoints': {},
          'healthCheck.diskThreshold': 100,
          'healthCheck.memoryThreshold': 512 * 1024 * 1024,
        };
        return settings[key] ?? defaultValue;
      }),
    };

    service = new HealthCheckService(
      mockTerminusHealthService as any,
      mockHttpHealthIndicator as any,
      mockDiskHealthIndicator as any,
      mockMemoryHealthIndicator as any,
      mockAppSettingsService as any,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create service', () => {
      expect(service).toBeDefined();
    });
  });

  describe('onModuleInit', () => {
    it('should register configured health check endpoints', async () => {
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'healthCheck.endpoints') {
          return {
            'stt-service': 'http://localhost:8861/health',
            'tts-service': 'http://localhost:8863/health',
          };
        }
        return defaultValue;
      });

      // Create new service with configured endpoints
      const serviceWithEndpoints = new HealthCheckService(
        mockTerminusHealthService as any,
        mockHttpHealthIndicator as any,
        mockDiskHealthIndicator as any,
        mockMemoryHealthIndicator as any,
        mockAppSettingsService as any,
      );

      await serviceWithEndpoints.onModuleInit();

      // Verify endpoints were registered
      expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('healthCheck.endpoints', {});
    });

    it('should handle empty endpoints configuration', async () => {
      await service.onModuleInit();

      // Should not throw
      expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('healthCheck.endpoints', {});
    });
  });

  describe('checkHealth', () => {
    it('should execute all health indicators', async () => {
      mockTerminusHealthService.check.mockImplementation(async (indicators: (() => Promise<HealthIndicatorResult>)[]) => {
        // Execute all indicators
        for (const indicator of indicators) {
          await indicator();
        }
        return {
          status: 'ok',
          info: {
            storage: { status: 'up' },
            memory_heap: { status: 'up' },
            memory_rss: { status: 'up' },
          },
          error: {},
          details: {},
        };
      });

      const result = await service.checkHealth();

      expect(result.status).toBe('ok');
      expect(mockDiskHealthIndicator.checkStorage).toHaveBeenCalled();
      expect(mockMemoryHealthIndicator.checkHeap).toHaveBeenCalled();
      expect(mockMemoryHealthIndicator.checkRSS).toHaveBeenCalled();
    });

    it('should use configured disk threshold', async () => {
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'healthCheck.diskThreshold') return 80; // 80%
        if (key === 'healthCheck.memoryThreshold') return 512 * 1024 * 1024;
        return defaultValue;
      });

      mockTerminusHealthService.check.mockImplementation(async (indicators: (() => Promise<HealthIndicatorResult>)[]) => {
        for (const indicator of indicators) {
          await indicator();
        }
        return { status: 'ok', info: {}, error: {}, details: {} };
      });

      await service.checkHealth();

      expect(mockDiskHealthIndicator.checkStorage).toHaveBeenCalledWith('storage', {
        path: '/',
        thresholdPercent: 0.8, // 80% converted to decimal
      });
    });

    it('should use configured memory threshold', async () => {
      const customMemoryThreshold = 1024 * 1024 * 1024; // 1GB
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'healthCheck.memoryThreshold') return customMemoryThreshold;
        return defaultValue;
      });

      mockTerminusHealthService.check.mockImplementation(async (indicators: (() => Promise<HealthIndicatorResult>)[]) => {
        for (const indicator of indicators) {
          await indicator();
        }
        return { status: 'ok', info: {}, error: {}, details: {} };
      });

      await service.checkHealth();

      expect(mockMemoryHealthIndicator.checkHeap).toHaveBeenCalledWith('memory_heap', customMemoryThreshold);
      expect(mockMemoryHealthIndicator.checkRSS).toHaveBeenCalledWith('memory_rss', customMemoryThreshold);
    });

    it('should include custom health indicators', async () => {
      const customIndicator = vi.fn().mockResolvedValue({ custom: { status: 'up' } });
      service.registerHealthIndicator('custom', customIndicator);

      mockTerminusHealthService.check.mockImplementation(async (indicators: (() => Promise<HealthIndicatorResult>)[]) => {
        for (const indicator of indicators) {
          await indicator();
        }
        return { status: 'ok', info: {}, error: {}, details: {} };
      });

      await service.checkHealth();

      expect(customIndicator).toHaveBeenCalled();
    });

    it('should throw error when health check fails', async () => {
      mockTerminusHealthService.check.mockRejectedValue(new Error('Health check failed'));

      await expect(service.checkHealth()).rejects.toThrow('Health check failed');
    });
  });

  describe('registerHealthIndicator', () => {
    it('should register a custom health indicator that can be checked', async () => {
      const customCheck = vi.fn().mockResolvedValue({ database: { status: 'up' } });

      service.registerHealthIndicator('database', customCheck);

      // Verify BEHAVIOR: registered indicator can be checked via checkSubsystem
      const result = await service.checkSubsystem('database');
      expect(result).toEqual({ database: { status: 'up' } });
      expect(customCheck).toHaveBeenCalled();
    });

    it('should allow registering multiple indicators independently', async () => {
      const dbCheck = vi.fn().mockResolvedValue({ database: { status: 'up' } });
      const cacheCheck = vi.fn().mockResolvedValue({ cache: { status: 'up' } });
      const queueCheck = vi.fn().mockResolvedValue({ queue: { status: 'up' } });

      service.registerHealthIndicator('database', dbCheck);
      service.registerHealthIndicator('cache', cacheCheck);
      service.registerHealthIndicator('queue', queueCheck);

      // Verify BEHAVIOR: each indicator works independently
      const dbResult = await service.checkSubsystem('database');
      const cacheResult = await service.checkSubsystem('cache');
      const queueResult = await service.checkSubsystem('queue');

      expect(dbResult).toEqual({ database: { status: 'up' } });
      expect(cacheResult).toEqual({ cache: { status: 'up' } });
      expect(queueResult).toEqual({ queue: { status: 'up' } });
    });

    it('should allow overwriting an existing indicator', async () => {
      const oldCheck = vi.fn().mockResolvedValue({ database: { status: 'down' } });
      const newCheck = vi.fn().mockResolvedValue({ database: { status: 'up' } });

      service.registerHealthIndicator('database', oldCheck);
      service.registerHealthIndicator('database', newCheck);

      // Verify BEHAVIOR: new indicator replaces old one
      const result = await service.checkSubsystem('database');
      expect(result).toEqual({ database: { status: 'up' } });
      expect(newCheck).toHaveBeenCalled();
      expect(oldCheck).not.toHaveBeenCalled();
    });
  });

  describe('checkSubsystem', () => {
    it('should check a specific registered subsystem', async () => {
      const dbCheck = vi.fn().mockResolvedValue({ database: { status: 'up' } });
      service.registerHealthIndicator('database', dbCheck);

      const result = await service.checkSubsystem('database');

      expect(dbCheck).toHaveBeenCalled();
      expect(result).toEqual({ database: { status: 'up' } });
    });

    it('should throw error for non-existent subsystem', async () => {
      await expect(service.checkSubsystem('non-existent')).rejects.toThrow('Health indicator not found: non-existent');
    });

    it('should propagate errors from subsystem check', async () => {
      const failingCheck = vi.fn().mockRejectedValue(new Error('Subsystem error'));
      service.registerHealthIndicator('failing', failingCheck);

      await expect(service.checkSubsystem('failing')).rejects.toThrow('Subsystem error');
    });
  });

  describe('health check result structure', () => {
    it('should return proper health check result structure', async () => {
      const expectedResult: HealthCheckResult = {
        status: 'ok',
        info: {
          storage: { status: 'up' },
          memory_heap: { status: 'up' },
          memory_rss: { status: 'up' },
        },
        error: {},
        details: {
          storage: { status: 'up' },
          memory_heap: { status: 'up' },
          memory_rss: { status: 'up' },
        },
      };

      mockTerminusHealthService.check.mockResolvedValue(expectedResult);

      const result = await service.checkHealth();

      expect(result).toEqual(expectedResult);
      expect(result.status).toBe('ok');
      expect(result.info).toBeDefined();
      expect(result.error).toBeDefined();
      expect(result.details).toBeDefined();
    });

    it('should handle error status in health check', async () => {
      const errorResult: HealthCheckResult = {
        status: 'error',
        info: {},
        error: {
          storage: { status: 'down', message: 'Disk full' },
        },
        details: {
          storage: { status: 'down', message: 'Disk full' },
        },
      };

      mockTerminusHealthService.check.mockResolvedValue(errorResult);

      const result = await service.checkHealth();

      expect(result.status).toBe('error');
      expect(result.error).toHaveProperty('storage');
    });
  });

  describe('HTTP health indicators', () => {
    it('should register HTTP health indicators from settings', async () => {
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'healthCheck.endpoints') {
          return {
            'api-gateway': 'http://localhost:8868/health',
            'stt-service': 'http://localhost:8861/health',
          };
        }
        return defaultValue;
      });

      const serviceWithEndpoints = new HealthCheckService(
        mockTerminusHealthService as any,
        mockHttpHealthIndicator as any,
        mockDiskHealthIndicator as any,
        mockMemoryHealthIndicator as any,
        mockAppSettingsService as any,
      );

      await serviceWithEndpoints.onModuleInit();

      // Verify the HTTP indicators were set up
      mockTerminusHealthService.check.mockImplementation(async (indicators: (() => Promise<HealthIndicatorResult>)[]) => {
        for (const indicator of indicators) {
          await indicator();
        }
        return { status: 'ok', info: {}, error: {}, details: {} };
      });

      await serviceWithEndpoints.checkHealth();

      // The HTTP indicators should be called during health check
      expect(mockHttpHealthIndicator.pingCheck).toHaveBeenCalledWith('api-gateway', 'http://localhost:8868/health');
      expect(mockHttpHealthIndicator.pingCheck).toHaveBeenCalledWith('stt-service', 'http://localhost:8861/health');
    });
  });

  describe('edge cases', () => {
    it('should use default thresholds when app settings return defaults', async () => {
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        return defaultValue;
      });

      mockTerminusHealthService.check.mockImplementation(async (indicators: (() => Promise<HealthIndicatorResult>)[]) => {
        for (const indicator of indicators) {
          await indicator();
        }
        return { status: 'ok', info: {}, error: {}, details: {} };
      });

      const result = await service.checkHealth();

      // Verify BEHAVIOR: health check completes successfully with defaults
      expect(result.status).toBe('ok');
      // Verify default thresholds were used (100% disk, 512MB memory)
      expect(mockDiskHealthIndicator.checkStorage).toHaveBeenCalledWith('storage', {
        path: '/',
        thresholdPercent: 1.0, // 100% default
      });
    });

    it('should handle concurrent health checks without interference', async () => {
      let callCount = 0;
      mockTerminusHealthService.check.mockImplementation(async () => {
        callCount++;
        // Simulate some async work
        await new Promise((resolve) => setTimeout(resolve, 10));
        return {
          status: 'ok',
          info: { callNumber: callCount },
          error: {},
          details: {},
        };
      });

      const results = await Promise.all([service.checkHealth(), service.checkHealth(), service.checkHealth()]);

      // Verify BEHAVIOR: all concurrent checks complete successfully
      expect(results).toHaveLength(3);
      results.forEach((result) => {
        expect(result.status).toBe('ok');
      });
      // Verify all checks were actually executed
      expect(callCount).toBe(3);
    });

    it('should handle indicator that returns slowly', async () => {
      const slowIndicator = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { slow: { status: 'up', responseTime: 50 } };
      });
      service.registerHealthIndicator('slow', slowIndicator);

      mockTerminusHealthService.check.mockImplementation(async (indicators: (() => Promise<HealthIndicatorResult>)[]) => {
        for (const indicator of indicators) {
          await indicator();
        }
        return { status: 'ok', info: {}, error: {}, details: {} };
      });

      const startTime = Date.now();
      const result = await service.checkHealth();
      const duration = Date.now() - startTime;

      // Verify BEHAVIOR: slow indicator was actually executed
      expect(result.status).toBe('ok');
      expect(slowIndicator).toHaveBeenCalled();
      expect(duration).toBeGreaterThanOrEqual(45);
    });
  });
});
