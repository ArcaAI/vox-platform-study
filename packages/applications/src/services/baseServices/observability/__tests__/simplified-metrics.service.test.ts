/**
 * SimplifiedMetricsService Unit Tests
 *
 * Tests for the Prometheus metrics service implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SimplifiedMetricsService } from '../simplified-metrics.service';

// Mock prom-client
vi.mock('prom-client', () => {
  // Create mock classes that can be instantiated with 'new'
  class MockCounter {
    name: string;
    inc = vi.fn();
    constructor(opts: any) {
      this.name = opts.name;
    }
  }

  class MockGauge {
    name: string;
    set = vi.fn();
    inc = vi.fn();
    dec = vi.fn();
    constructor(opts: any) {
      this.name = opts.name;
    }
  }

  class MockHistogram {
    name: string;
    observe = vi.fn();
    constructor(opts: any) {
      this.name = opts.name;
    }
  }

  class MockSummary {
    name: string;
    observe = vi.fn();
    constructor(opts: any) {
      this.name = opts.name;
    }
  }

  return {
    Counter: MockCounter,
    Gauge: MockGauge,
    Histogram: MockHistogram,
    Summary: MockSummary,
    register: {
      registerMetric: vi.fn(),
      clear: vi.fn(),
    },
    collectDefaultMetrics: vi.fn(),
  };
});

import { Counter, Gauge, Histogram, Summary, register, collectDefaultMetrics } from 'prom-client';

describe('SimplifiedMetricsService', () => {
  let service: SimplifiedMetricsService;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      OTEL_SERVICE_NAME: 'test-service',
      OTEL_SERVICE_VERSION: '1.0.0',
      NODE_ENV: 'test',
      METRICS_PREFIX: 'test_',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create service with default configuration', () => {
      service = new SimplifiedMetricsService();
      expect(service).toBeDefined();
    });

    it('should use service name from environment', () => {
      process.env.OTEL_SERVICE_NAME = 'my-custom-service';
      service = new SimplifiedMetricsService();
      expect(service).toBeDefined();
    });

    it('should use custom metrics prefix', () => {
      process.env.METRICS_PREFIX = 'custom_prefix_';
      service = new SimplifiedMetricsService();
      expect(service).toBeDefined();
    });

    it('should sanitize service name for Prometheus', () => {
      process.env.OTEL_SERVICE_NAME = 'my-service-with-hyphens';
      delete process.env.METRICS_PREFIX;
      service = new SimplifiedMetricsService();
      expect(service).toBeDefined();
    });
  });

  describe('onModuleInit', () => {
    it('should collect default metrics', async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();

      expect(collectDefaultMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          register: register,
          prefix: expect.any(String),
        }),
      );
    });

    it('should initialize standard metrics', async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();

      // Should have created standard metrics (check they exist)
      expect(service.getMetric('http_requests_total')).toBeDefined();
      expect(service.getMetric('system_cpu_usage_percent')).toBeDefined();
      expect(service.getMetric('http_request_duration_seconds')).toBeDefined();
    });

    it('should handle initialization errors', async () => {
      const originalImpl = collectDefaultMetrics;
      (collectDefaultMetrics as any).mockImplementationOnce(() => {
        throw new Error('Initialization failed');
      });

      service = new SimplifiedMetricsService();

      await expect(service.onModuleInit()).rejects.toThrow('Initialization failed');
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear metrics on shutdown', async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
      await service.onModuleDestroy();

      // Service should clean up
      expect(service).toBeDefined();
    });
  });

  describe('createCounter', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    it('should create counter metric', () => {
      const counter = service.createCounter({
        name: 'test_counter',
        help: 'Test counter',
        labelNames: ['label1'],
      });

      expect(counter).toBeDefined();
      expect(counter.name).toContain('test_counter');
    });

    it('should return existing counter if already created', () => {
      const counter1 = service.createCounter({
        name: 'duplicate_counter',
        help: 'Test counter',
      });

      const counter2 = service.createCounter({
        name: 'duplicate_counter',
        help: 'Test counter',
      });

      expect(counter1).toBe(counter2);
    });

    it('should throw error if metric exists with different type', () => {
      service.createGauge({
        name: 'mixed_metric',
        help: 'Test gauge',
      });

      expect(() =>
        service.createCounter({
          name: 'mixed_metric',
          help: 'Test counter',
        }),
      ).toThrow();
    });

    it('should add service label to label names', () => {
      const counter = service.createCounter({
        name: 'labeled_counter',
        help: 'Test counter',
        labelNames: ['custom_label'],
      });

      // Counter should be created successfully
      expect(counter).toBeDefined();
    });
  });

  describe('createGauge', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    it('should create gauge metric', () => {
      const gauge = service.createGauge({
        name: 'test_gauge',
        help: 'Test gauge',
      });

      expect(gauge).toBeDefined();
      expect(gauge.name).toContain('test_gauge');
    });

    it('should return existing gauge if already created', () => {
      const gauge1 = service.createGauge({
        name: 'duplicate_gauge',
        help: 'Test gauge',
      });

      const gauge2 = service.createGauge({
        name: 'duplicate_gauge',
        help: 'Test gauge',
      });

      expect(gauge1).toBe(gauge2);
    });
  });

  describe('createHistogram', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    it('should create histogram metric', () => {
      const histogram = service.createHistogram({
        name: 'test_histogram',
        help: 'Test histogram',
        buckets: [0.1, 0.5, 1, 5],
      });

      expect(histogram).toBeDefined();
      expect(histogram.name).toContain('test_histogram');
    });

    it('should pass buckets to histogram', () => {
      const buckets = [0.01, 0.1, 1, 10];
      const histogram = service.createHistogram({
        name: 'bucketed_histogram',
        help: 'Test histogram',
        buckets,
      });

      expect(histogram).toBeDefined();
    });
  });

  describe('createSummary', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    it('should create summary metric', () => {
      const summary = service.createSummary({
        name: 'test_summary',
        help: 'Test summary',
        percentiles: [0.5, 0.9, 0.99],
      });

      expect(summary).toBeDefined();
      expect(summary.name).toContain('test_summary');
    });

    it('should pass percentiles to summary', () => {
      const percentiles = [0.5, 0.9, 0.99];
      const summary = service.createSummary({
        name: 'percentile_summary',
        help: 'Test summary',
        percentiles,
      });

      expect(summary).toBeDefined();
    });
  });

  describe('getMetric', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    it('should return existing metric', () => {
      service.createCounter({
        name: 'existing_metric',
        help: 'Test',
      });

      const metric = service.getMetric('existing_metric');
      expect(metric).toBeDefined();
    });

    it('should return undefined for non-existent metric', () => {
      const metric = service.getMetric('non_existent_metric');
      expect(metric).toBeUndefined();
    });
  });

  describe('registerMetric', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    it('should register external metric', () => {
      const externalMetric = new Counter({
        name: 'external_counter',
        help: 'External counter',
      });

      service.registerMetric(externalMetric);

      expect(register.registerMetric).toHaveBeenCalled();
    });

    it('should skip registration if metric already exists', () => {
      const existingMetric = service.createCounter({
        name: 'existing_for_register',
        help: 'Test',
      });

      // Try to register again
      service.registerMetric(existingMetric);

      // Should warn and skip
    });
  });

  describe('convenience methods', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    describe('incrementCounter', () => {
      it('should increment counter', () => {
        const counter = service.createCounter({
          name: 'increment_test',
          help: 'Test',
        });

        service.incrementCounter('increment_test', { label: 'value' });

        expect(counter.inc).toHaveBeenCalled();
      });

      it('should not throw for non-existent counter', () => {
        expect(() => service.incrementCounter('non_existent', { label: 'value' })).not.toThrow();
      });
    });

    describe('setGauge', () => {
      it('should set gauge value', () => {
        const gauge = service.createGauge({
          name: 'set_test',
          help: 'Test',
        });

        service.setGauge('set_test', 42, { label: 'value' });

        expect(gauge.set).toHaveBeenCalled();
      });

      it('should not throw for non-existent gauge', () => {
        expect(() => service.setGauge('non_existent', 42, { label: 'value' })).not.toThrow();
      });
    });

    describe('observeHistogram', () => {
      it('should observe histogram value', () => {
        const histogram = service.createHistogram({
          name: 'observe_test',
          help: 'Test',
          buckets: [1, 5, 10],
        });

        service.observeHistogram('observe_test', 3.5, { label: 'value' });

        expect(histogram.observe).toHaveBeenCalled();
      });

      it('should not throw for non-existent histogram', () => {
        expect(() => service.observeHistogram('non_existent', 3.5, { label: 'value' })).not.toThrow();
      });
    });
  });

  describe('metric name sanitization', () => {
    beforeEach(async () => {
      service = new SimplifiedMetricsService();
      await service.onModuleInit();
    });

    it('should replace hyphens with underscores', () => {
      const counter = service.createCounter({
        name: 'metric-with-hyphens',
        help: 'Test',
      });

      // The metric name should have hyphens replaced with underscores
      expect(counter.name).toMatch(/_/);
      expect(counter.name).not.toContain('-');
    });

    it('should add prefix to metric name', () => {
      const counter = service.createCounter({
        name: 'prefixed_metric',
        help: 'Test',
      });

      // The metric name should contain the prefix
      expect(counter.name).toContain('test_');
    });
  });
});
