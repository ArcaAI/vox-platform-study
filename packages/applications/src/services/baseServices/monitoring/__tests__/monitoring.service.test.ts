/**
 * MonitoringService Unit Tests
 *
 * Tests for the monitoring service that provides system monitoring and KPI tracking.
 *
 * Testing Strategy:
 * - Test actual KPI recording and retrieval behavior
 * - Verify aggregation functions produce correct results
 * - Test subscription/notification system works correctly
 * - Ensure system metrics are calculated properly
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { MonitoringService } from '../monitoring.service';
import { IMetricsService } from '../../metrics';
import { IAppSettingsService } from '../../_meta/appSettings';
import { Gauge } from 'prom-client';

// Mock os module - external system boundary
// Values chosen to make calculations verifiable
vi.mock('os', () => ({
  cpus: vi.fn().mockReturnValue([
    // CPU 1: 150 busy (user+sys), 850 idle = 15% usage
    { times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } },
    // CPU 2: 180 busy (user+sys), 820 idle = 18% usage
    { times: { user: 120, nice: 0, sys: 60, idle: 820, irq: 0 } },
  ]),
  totalmem: vi.fn().mockReturnValue(16 * 1024 * 1024 * 1024), // 16GB total
  freemem: vi.fn().mockReturnValue(8 * 1024 * 1024 * 1024), // 8GB free = 50% used
}));

// Mock v8 module - external runtime boundary
vi.mock('v8', () => ({
  getHeapStatistics: vi.fn().mockReturnValue({
    total_heap_size: 100 * 1024 * 1024, // 100MB
    used_heap_size: 50 * 1024 * 1024, // 50MB = 50% used
  }),
}));

describe('MonitoringService', () => {
  let service: MonitoringService;
  let mockAppSettingsService: {
    getValueWithDefault: Mock;
  };
  let mockMetricsService: {
    getMetric: Mock;
  };
  let mockCpuGauge: {
    set: Mock;
  };
  let mockMemoryGauge: {
    set: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockAppSettingsService = {
      getValueWithDefault: vi.fn().mockImplementation((key: string, defaultValue: any) => {
        const settings: Record<string, any> = {
          'monitoring.retentionLimit': 1000,
          'monitoring.integrations': [],
          'monitoring.collectInterval': 15000,
        };
        return settings[key] ?? defaultValue;
      }),
    };

    mockMetricsService = {
      getMetric: vi.fn().mockReturnValue(undefined),
    };

    mockCpuGauge = {
      set: vi.fn(),
    };

    mockMemoryGauge = {
      set: vi.fn(),
    };

    service = new MonitoringService(mockAppSettingsService as any, mockMetricsService as any, mockCpuGauge as any, mockMemoryGauge as any);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create service', () => {
      expect(service).toBeDefined();
    });

    it('should get retention limit from app settings', () => {
      expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('monitoring.retentionLimit', 1000);
    });

    it('should get integrations list from app settings', () => {
      expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('monitoring.integrations', []);
    });
  });

  describe('onModuleInit', () => {
    it('should setup periodic system metrics collection', async () => {
      await service.onModuleInit();

      expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('monitoring.collectInterval', 15000);
    });

    it('should throw error if initialization fails', async () => {
      // Create a service that will fail during onModuleInit
      const failingAppSettings = {
        getValueWithDefault: vi
          .fn()
          .mockReturnValueOnce(1000) // First call in constructor for retentionLimit
          .mockReturnValueOnce([]) // Second call in constructor for integrations
          .mockImplementation(() => {
            throw new Error('Init error');
          }),
      };

      const failingService = new MonitoringService(failingAppSettings as any, mockMetricsService as any, mockCpuGauge as any, mockMemoryGauge as any);

      await expect(failingService.onModuleInit()).rejects.toThrow('Init error');
    });
  });

  describe('getSystemMetrics', () => {
    it('should return system metrics', async () => {
      const metrics = await service.getSystemMetrics();

      expect(metrics).toHaveProperty('cpuUsage');
      expect(metrics).toHaveProperty('memoryUsage');
      expect(metrics).toHaveProperty('threadCount');
      expect(metrics).toHaveProperty('uptime');
    });

    it('should calculate CPU usage correctly', async () => {
      const metrics = await service.getSystemMetrics();

      // CPU usage should be a percentage between 0 and 100
      expect(metrics.cpuUsage).toBeGreaterThanOrEqual(0);
      expect(metrics.cpuUsage).toBeLessThanOrEqual(100);
    });

    it('should calculate memory usage correctly', async () => {
      const metrics = await service.getSystemMetrics();

      // Memory usage should be 50% (8GB used out of 16GB)
      expect(metrics.memoryUsage).toBeCloseTo(50, 0);
    });

    it('should include uptime', async () => {
      const metrics = await service.getSystemMetrics();

      expect(metrics.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should include optional queue length', async () => {
      const metrics = await service.getSystemMetrics();

      // Queue length is optional and defaults to 0 in placeholder
      expect(metrics.processingQueueLength).toBeDefined();
    });

    it('should include optional active connections', async () => {
      const metrics = await service.getSystemMetrics();

      // Active connections is optional and defaults to 0 in placeholder
      expect(metrics.activeConnections).toBeDefined();
    });
  });

  describe('recordKpi', () => {
    it('should record a KPI data point', async () => {
      await service.recordKpi('test.metric', 42);

      const history = await service.getKpiHistory('test.metric', new Date(Date.now() - 60000), new Date(Date.now() + 60000));

      expect(history).toHaveLength(1);
      expect(history[0].value).toBe(42);
    });

    it('should record KPI with metadata', async () => {
      await service.recordKpi('test.metric', 100, { unit: 'ms', source: 'api' });

      const history = await service.getKpiHistory('test.metric', new Date(Date.now() - 60000), new Date(Date.now() + 60000));

      expect(history[0].metadata).toEqual({ unit: 'ms', source: 'api' });
    });

    it('should trim history when exceeding retention limit', async () => {
      // Create service with low retention limit
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'monitoring.retentionLimit') return 5;
        return defaultValue;
      });

      const limitedService = new MonitoringService(
        mockAppSettingsService as any,
        mockMetricsService as any,
        mockCpuGauge as any,
        mockMemoryGauge as any,
      );

      // Record more than retention limit
      for (let i = 0; i < 10; i++) {
        await limitedService.recordKpi('trimmed.metric', i);
      }

      const history = await limitedService.getKpiHistory('trimmed.metric', new Date(Date.now() - 60000), new Date(Date.now() + 60000));

      expect(history).toHaveLength(5);
      // Should keep the most recent values (5-9)
      expect(history[0].value).toBe(5);
      expect(history[4].value).toBe(9);
    });

    it('should update Prometheus metric if exists', async () => {
      const mockGauge = {
        set: vi.fn(),
      };
      mockMetricsService.getMetric.mockReturnValue(mockGauge);

      await service.recordKpi('prometheus.metric', 75);

      expect(mockMetricsService.getMetric).toHaveBeenCalledWith('prometheus.metric');
      expect(mockGauge.set).toHaveBeenCalledWith(75);
    });

    it('should notify subscribers', async () => {
      const callback = vi.fn();
      service.subscribeToMetric('subscribed.metric', callback);

      await service.recordKpi('subscribed.metric', 50);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 50,
          timestamp: expect.any(Date),
        }),
      );
    });
  });

  describe('getKpiHistory', () => {
    it('should return empty array for non-existent metric', async () => {
      const history = await service.getKpiHistory('non.existent', new Date(Date.now() - 60000), new Date(Date.now() + 60000));

      expect(history).toHaveLength(0);
    });

    it('should filter by time range', async () => {
      const now = Date.now();

      // Record data points at different times
      vi.setSystemTime(now - 30000);
      await service.recordKpi('time.filtered', 1);

      vi.setSystemTime(now);
      await service.recordKpi('time.filtered', 2);

      vi.setSystemTime(now + 30000);
      await service.recordKpi('time.filtered', 3);

      // Query for middle time range only
      const history = await service.getKpiHistory('time.filtered', new Date(now - 10000), new Date(now + 10000));

      expect(history).toHaveLength(1);
      expect(history[0].value).toBe(2);
    });

    it('should apply avg aggregation', async () => {
      await service.recordKpi('agg.metric', 10);
      await service.recordKpi('agg.metric', 20);
      await service.recordKpi('agg.metric', 30);

      const history = await service.getKpiHistory('agg.metric', new Date(Date.now() - 60000), new Date(Date.now() + 60000), 'avg');

      expect(history).toHaveLength(1);
      expect(history[0].value).toBe(20); // (10 + 20 + 30) / 3
    });

    it('should apply sum aggregation', async () => {
      await service.recordKpi('sum.metric', 10);
      await service.recordKpi('sum.metric', 20);
      await service.recordKpi('sum.metric', 30);

      const history = await service.getKpiHistory('sum.metric', new Date(Date.now() - 60000), new Date(Date.now() + 60000), 'sum');

      expect(history).toHaveLength(1);
      expect(history[0].value).toBe(60);
    });

    it('should apply max aggregation', async () => {
      await service.recordKpi('max.metric', 10);
      await service.recordKpi('max.metric', 50);
      await service.recordKpi('max.metric', 30);

      const history = await service.getKpiHistory('max.metric', new Date(Date.now() - 60000), new Date(Date.now() + 60000), 'max');

      expect(history).toHaveLength(1);
      expect(history[0].value).toBe(50);
    });

    it('should apply min aggregation', async () => {
      await service.recordKpi('min.metric', 10);
      await service.recordKpi('min.metric', 5);
      await service.recordKpi('min.metric', 30);

      const history = await service.getKpiHistory('min.metric', new Date(Date.now() - 60000), new Date(Date.now() + 60000), 'min');

      expect(history).toHaveLength(1);
      expect(history[0].value).toBe(5);
    });
  });

  describe('checkIntegrationStatus', () => {
    it('should return empty array when no integrations configured', async () => {
      const status = await service.checkIntegrationStatus();

      expect(status).toHaveLength(0);
    });

    it('should check status of configured integrations', async () => {
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'monitoring.integrations') {
          return ['database', 'redis', 'kafka'];
        }
        return defaultValue;
      });

      const serviceWithIntegrations = new MonitoringService(
        mockAppSettingsService as any,
        mockMetricsService as any,
        mockCpuGauge as any,
        mockMemoryGauge as any,
      );

      const status = await serviceWithIntegrations.checkIntegrationStatus();

      expect(status).toHaveLength(3);
      expect(status[0].name).toBe('database');
      expect(status[1].name).toBe('redis');
      expect(status[2].name).toBe('kafka');
    });

    it('should include latency in integration status', async () => {
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'monitoring.integrations') return ['test-integration'];
        return defaultValue;
      });

      const serviceWithIntegration = new MonitoringService(
        mockAppSettingsService as any,
        mockMetricsService as any,
        mockCpuGauge as any,
        mockMemoryGauge as any,
      );

      const status = await serviceWithIntegration.checkIntegrationStatus();

      expect(status[0]).toHaveProperty('latency');
      expect(status[0]).toHaveProperty('lastChecked');
      expect(status[0]).toHaveProperty('isConnected');
    });
  });

  describe('subscribeToMetric', () => {
    it('should create unique subscription ID for each subscription', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const subscriptionId1 = service.subscribeToMetric('test.metric', callback1);
      const subscriptionId2 = service.subscribeToMetric('test.metric', callback2);

      // Verify BEHAVIOR: each subscription gets unique ID
      expect(subscriptionId1).toBeDefined();
      expect(subscriptionId2).toBeDefined();
      expect(subscriptionId1).not.toBe(subscriptionId2);
      expect(subscriptionId1).toContain('test.metric');
    });

    it('should notify subscriber with complete data point when metric is recorded', async () => {
      const callback = vi.fn();
      service.subscribeToMetric('callback.metric', callback);

      await service.recordKpi('callback.metric', 100, { source: 'test' });

      // Verify BEHAVIOR: callback receives complete data point
      expect(callback).toHaveBeenCalledTimes(1);
      const dataPoint = callback.mock.calls[0][0];
      expect(dataPoint.value).toBe(100);
      expect(dataPoint.timestamp).toBeInstanceOf(Date);
      expect(dataPoint.metadata).toEqual({ source: 'test' });
    });

    it('should notify all subscribers independently', async () => {
      const receivedValues: number[] = [];
      const callback1 = vi.fn().mockImplementation((dp) => receivedValues.push(dp.value * 2));
      const callback2 = vi.fn().mockImplementation((dp) => receivedValues.push(dp.value * 3));

      service.subscribeToMetric('multi.metric', callback1);
      service.subscribeToMetric('multi.metric', callback2);

      await service.recordKpi('multi.metric', 10);

      // Verify BEHAVIOR: both subscribers received and processed the value
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(receivedValues).toContain(20); // 10 * 2
      expect(receivedValues).toContain(30); // 10 * 3
    });

    it('should isolate subscriber errors without affecting other subscribers', async () => {
      const results: string[] = [];
      const failingCallback = vi.fn().mockImplementation(() => {
        throw new Error('Subscriber error');
      });
      const workingCallback = vi.fn().mockImplementation(() => {
        results.push('success');
      });

      service.subscribeToMetric('error.metric', failingCallback);
      service.subscribeToMetric('error.metric', workingCallback);

      // Should not throw despite failing subscriber
      await service.recordKpi('error.metric', 25);

      // Verify BEHAVIOR: working callback executed despite other subscriber failing
      expect(workingCallback).toHaveBeenCalled();
      expect(results).toContain('success');
    });

    it('should not notify subscribers of different metrics', async () => {
      const callback = vi.fn();
      service.subscribeToMetric('metric.a', callback);

      await service.recordKpi('metric.b', 100);

      // Verify BEHAVIOR: subscriber only notified for subscribed metric
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribeFromMetric', () => {
    it('should remove subscription', async () => {
      const callback = vi.fn();
      const subscriptionId = service.subscribeToMetric('unsub.metric', callback);

      service.unsubscribeFromMetric(subscriptionId);

      await service.recordKpi('unsub.metric', 100);

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle non-existent subscription gracefully', () => {
      expect(() => service.unsubscribeFromMetric('non-existent-id')).not.toThrow();
    });

    it('should clean up empty subscriber maps', async () => {
      const callback = vi.fn();
      const subscriptionId = service.subscribeToMetric('cleanup.metric', callback);

      service.unsubscribeFromMetric(subscriptionId);

      // Recording should not throw even though there are no subscribers
      await service.recordKpi('cleanup.metric', 100);

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Prometheus metric updates', () => {
    it('should update Counter metric', async () => {
      const mockCounter = {
        inc: vi.fn(),
      };
      mockMetricsService.getMetric.mockReturnValue(mockCounter);

      await service.recordKpi('counter.metric', 5);

      expect(mockCounter.inc).toHaveBeenCalledWith(5);
    });

    it('should update Gauge metric', async () => {
      const mockGauge = {
        set: vi.fn(),
      };
      mockMetricsService.getMetric.mockReturnValue(mockGauge);

      await service.recordKpi('gauge.metric', 75);

      expect(mockGauge.set).toHaveBeenCalledWith(75);
    });

    it('should update Histogram metric', async () => {
      const mockHistogram = {
        observe: vi.fn(),
      };
      mockMetricsService.getMetric.mockReturnValue(mockHistogram);

      await service.recordKpi('histogram.metric', 0.5);

      expect(mockHistogram.observe).toHaveBeenCalledWith(0.5);
    });

    it('should handle metric update with labels', async () => {
      const mockGauge = {
        set: vi.fn(),
      };
      mockMetricsService.getMetric.mockReturnValue(mockGauge);

      await service.recordKpi('labeled.metric', 100, { method: 'GET', path: '/api' });

      expect(mockGauge.set).toHaveBeenCalledWith({ method: 'GET', path: '/api' }, 100);
    });
  });

  describe('system metrics collection interval', () => {
    it('should setup periodic system metrics collection', async () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      await service.onModuleInit();

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('monitoring.collectInterval', 15000);
    });

    it('should use custom collect interval from settings', async () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'monitoring.collectInterval') return 5000;
        if (key === 'monitoring.retentionLimit') return 1000;
        if (key === 'monitoring.integrations') return [];
        return defaultValue;
      });

      const customIntervalService = new MonitoringService(
        mockAppSettingsService as any,
        mockMetricsService as any,
        mockCpuGauge as any,
        mockMemoryGauge as any,
      );

      await customIntervalService.onModuleInit();

      // Verify setInterval was called with the custom interval
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    });
  });

  describe('error handling', () => {
    it('should handle getSystemMetrics errors', async () => {
      const os = await import('os');
      (os.cpus as Mock).mockImplementation(() => {
        throw new Error('OS error');
      });

      await expect(service.getSystemMetrics()).rejects.toThrow('OS error');
    });

    it('should handle recordKpi errors', async () => {
      // Force an error by making the Map operations fail
      const originalSet = Map.prototype.set;
      Map.prototype.set = vi.fn().mockImplementation(() => {
        throw new Error('Map error');
      });

      await expect(service.recordKpi('error.metric', 100)).rejects.toThrow('Map error');

      Map.prototype.set = originalSet;
    });
  });
});
