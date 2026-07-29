/**
 * MetricsService Unit Tests
 *
 * Tests for the metrics service that provides Prometheus metrics.
 *
 * Testing Strategy:
 * - Test actual metric creation and retrieval behavior
 * - Verify metric type enforcement (can't create gauge with counter name)
 * - Test metric operations (inc, set, observe) work correctly
 * - Ensure metrics are properly registered and accessible
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { MetricsService } from '../metrics.service';
import { Counter, Gauge, Histogram, Summary, register } from 'prom-client';
import { IAppSettingsService } from '../../_meta/appSettings';

// Mock prom-client - external metrics library
// These mocks simulate real Prometheus metric behavior
vi.mock('prom-client', () => {
  const mockRegister = {
    registerMetric: vi.fn(),
    clear: vi.fn(),
  };

  // Track metric values for behavior verification
  class MockCounter {
    name: string;
    help: string;
    labelNames: string[];
    private _value: number = 0;
    private _labeledValues: Map<string, number> = new Map();

    inc = vi.fn().mockImplementation((labelsOrValue?: any, value?: number) => {
      if (typeof labelsOrValue === 'number') {
        this._value += labelsOrValue;
      } else if (labelsOrValue && typeof value === 'number') {
        const key = JSON.stringify(labelsOrValue);
        this._labeledValues.set(key, (this._labeledValues.get(key) || 0) + value);
      } else {
        this._value += 1;
      }
    });
    reset = vi.fn().mockImplementation(() => {
      this._value = 0;
      this._labeledValues.clear();
    });

    // Helper for tests to verify value
    getValue = () => this._value;

    constructor(config: any) {
      this.name = config.name;
      this.help = config.help;
      this.labelNames = config.labelNames || [];
    }
  }

  class MockGauge {
    name: string;
    help: string;
    labelNames: string[];
    private _value: number = 0;

    set = vi.fn().mockImplementation((labelsOrValue: any, value?: number) => {
      if (typeof labelsOrValue === 'number') {
        this._value = labelsOrValue;
      } else if (value !== undefined) {
        this._value = value;
      }
    });
    inc = vi.fn().mockImplementation((labelsOrValue?: any, value?: number) => {
      if (typeof labelsOrValue === 'number') {
        this._value += labelsOrValue;
      } else {
        this._value += value ?? 1;
      }
    });
    dec = vi.fn().mockImplementation((labelsOrValue?: any, value?: number) => {
      if (typeof labelsOrValue === 'number') {
        this._value -= labelsOrValue;
      } else {
        this._value -= value ?? 1;
      }
    });
    reset = vi.fn().mockImplementation(() => {
      this._value = 0;
    });

    getValue = () => this._value;

    constructor(config: any) {
      this.name = config.name;
      this.help = config.help;
      this.labelNames = config.labelNames || [];
    }
  }

  class MockHistogram {
    name: string;
    help: string;
    labelNames: string[];
    buckets: number[];
    private _observations: number[] = [];

    observe = vi.fn().mockImplementation((labelsOrValue: any, value?: number) => {
      const v = typeof labelsOrValue === 'number' ? labelsOrValue : value;
      if (v !== undefined) {
        this._observations.push(v);
      }
    });
    reset = vi.fn().mockImplementation(() => {
      this._observations = [];
    });

    getObservations = () => [...this._observations];

    constructor(config: any) {
      this.name = config.name;
      this.help = config.help;
      this.labelNames = config.labelNames || [];
      this.buckets = config.buckets || [];
    }
  }

  class MockSummary {
    name: string;
    help: string;
    labelNames: string[];
    percentiles: number[];
    maxAgeSeconds?: number;
    ageBuckets?: number;
    private _observations: number[] = [];

    observe = vi.fn().mockImplementation((labelsOrValue: any, value?: number) => {
      const v = typeof labelsOrValue === 'number' ? labelsOrValue : value;
      if (v !== undefined) {
        this._observations.push(v);
      }
    });
    reset = vi.fn().mockImplementation(() => {
      this._observations = [];
    });

    getObservations = () => [...this._observations];

    constructor(config: any) {
      this.name = config.name;
      this.help = config.help;
      this.labelNames = config.labelNames || [];
      this.percentiles = config.percentiles || [];
      this.maxAgeSeconds = config.maxAgeSeconds;
      this.ageBuckets = config.ageBuckets;
    }
  }

  return {
    Counter: MockCounter,
    Gauge: MockGauge,
    Histogram: MockHistogram,
    Summary: MockSummary,
    register: mockRegister,
    collectDefaultMetrics: vi.fn(),
  };
});

describe('MetricsService', () => {
  let service: MetricsService;
  let mockAppSettingsService: {
    getValueWithDefault: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockAppSettingsService = {
      getValueWithDefault: vi.fn().mockImplementation((key: string, defaultValue: any) => {
        const settings: Record<string, any> = {
          'metrics.defaultMetricsInterval': 10000,
          'metrics.prefix': 'arca_',
        };
        return settings[key] ?? defaultValue;
      }),
    };

    service = new MetricsService(mockAppSettingsService as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create service', () => {
      expect(service).toBeDefined();
    });

    it('should get metrics interval from app settings', () => {
      expect(mockAppSettingsService.getValueWithDefault).toHaveBeenCalledWith('metrics.defaultMetricsInterval', 10000);
    });
  });

  describe('onModuleInit', () => {
    it('should initialize default metrics collection', async () => {
      const { collectDefaultMetrics } = await import('prom-client');

      await service.onModuleInit();

      expect(collectDefaultMetrics).toHaveBeenCalledWith({
        register: expect.any(Object),
        prefix: 'arca_',
      });
    });

    it('should create standard application metrics', async () => {
      await service.onModuleInit();

      // Verify standard metrics were created by checking they can be retrieved
      const httpRequestsCounter = service.getMetric('http_requests_total');
      expect(httpRequestsCounter).toBeDefined();
      expect(httpRequestsCounter?.name).toBe('http_requests_total');

      const httpDurationHistogram = service.getMetric('http_request_duration_seconds');
      expect(httpDurationHistogram).toBeDefined();
      expect(httpDurationHistogram?.name).toBe('http_request_duration_seconds');

      const activeConnectionsGauge = service.getMetric('active_connections');
      expect(activeConnectionsGauge).toBeDefined();
      expect(activeConnectionsGauge?.name).toBe('active_connections');
    });

    it('should use custom prefix from app settings', async () => {
      mockAppSettingsService.getValueWithDefault.mockImplementation((key: string, defaultValue: any) => {
        if (key === 'metrics.prefix') return 'custom_';
        return defaultValue;
      });

      const { collectDefaultMetrics } = await import('prom-client');

      await service.onModuleInit();

      expect(collectDefaultMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          prefix: 'custom_',
        }),
      );
    });

    it('should throw error if initialization fails', async () => {
      const { collectDefaultMetrics } = await import('prom-client');
      (collectDefaultMetrics as Mock).mockImplementation(() => {
        throw new Error('Init error');
      });

      await expect(service.onModuleInit()).rejects.toThrow('Init error');
    });
  });

  describe('createCounter', () => {
    it('should create a counter metric', () => {
      const counter = service.createCounter({
        name: 'test_counter',
        help: 'Test counter metric',
        labelNames: ['label1', 'label2'],
      });

      expect(counter).toBeDefined();
      expect(counter.name).toBe('test_counter');
      expect(counter.help).toBe('Test counter metric');
      expect(counter.labelNames).toEqual(['label1', 'label2']);
    });

    it('should return existing counter if already created', () => {
      const counter1 = service.createCounter({
        name: 'existing_counter',
        help: 'Existing counter',
      });

      const counter2 = service.createCounter({
        name: 'existing_counter',
        help: 'Existing counter',
      });

      expect(counter1).toBe(counter2);
    });

    it('should throw error if metric exists but is not a Counter', async () => {
      // First create a gauge
      service.createGauge({
        name: 'mixed_metric',
        help: 'Mixed metric',
      });

      // Then try to create a counter with the same name
      expect(() =>
        service.createCounter({
          name: 'mixed_metric',
          help: 'Mixed metric',
        }),
      ).toThrow('Metric mixed_metric already exists but is not a Counter');
    });

    it('should handle empty labelNames', () => {
      const counter = service.createCounter({
        name: 'no_labels_counter',
        help: 'Counter without labels',
      });

      expect(counter).toBeDefined();
      expect(counter.labelNames).toEqual([]);
    });
  });

  describe('createGauge', () => {
    it('should create a gauge metric', () => {
      const gauge = service.createGauge({
        name: 'test_gauge',
        help: 'Test gauge metric',
        labelNames: ['label1'],
      });

      expect(gauge).toBeDefined();
      expect(gauge.name).toBe('test_gauge');
      expect(gauge.help).toBe('Test gauge metric');
      expect(gauge.labelNames).toEqual(['label1']);
    });

    it('should return existing gauge if already created', () => {
      const gauge1 = service.createGauge({
        name: 'existing_gauge',
        help: 'Existing gauge',
      });

      const gauge2 = service.createGauge({
        name: 'existing_gauge',
        help: 'Existing gauge',
      });

      expect(gauge1).toBe(gauge2);
    });

    it('should throw error if metric exists but is not a Gauge', () => {
      service.createCounter({
        name: 'mixed_gauge_metric',
        help: 'Mixed metric',
      });

      expect(() =>
        service.createGauge({
          name: 'mixed_gauge_metric',
          help: 'Mixed metric',
        }),
      ).toThrow('Metric mixed_gauge_metric already exists but is not a Gauge');
    });
  });

  describe('createHistogram', () => {
    it('should create a histogram metric', () => {
      const histogram = service.createHistogram({
        name: 'test_histogram',
        help: 'Test histogram metric',
        labelNames: ['label1'],
        buckets: [0.1, 0.5, 1, 5, 10],
      });

      expect(histogram).toBeDefined();
      expect(histogram.name).toBe('test_histogram');
      expect(histogram.help).toBe('Test histogram metric');
      expect(histogram.labelNames).toEqual(['label1']);
      expect(histogram.buckets).toEqual([0.1, 0.5, 1, 5, 10]);
    });

    it('should return existing histogram if already created', () => {
      const histogram1 = service.createHistogram({
        name: 'existing_histogram',
        help: 'Existing histogram',
        buckets: [0.1, 1, 10],
      });

      const histogram2 = service.createHistogram({
        name: 'existing_histogram',
        help: 'Existing histogram',
        buckets: [0.1, 1, 10],
      });

      expect(histogram1).toBe(histogram2);
    });

    it('should throw error if metric exists but is not a Histogram', () => {
      service.createCounter({
        name: 'mixed_histogram_metric',
        help: 'Mixed metric',
      });

      expect(() =>
        service.createHistogram({
          name: 'mixed_histogram_metric',
          help: 'Mixed metric',
          buckets: [0.1, 1, 10],
        }),
      ).toThrow('Metric mixed_histogram_metric already exists but is not a Histogram');
    });
  });

  describe('createSummary', () => {
    it('should create a summary metric', () => {
      const summary = service.createSummary({
        name: 'test_summary',
        help: 'Test summary metric',
        labelNames: ['label1'],
        percentiles: [0.5, 0.9, 0.99],
        maxAgeSeconds: 600,
        ageBuckets: 5,
      });

      expect(summary).toBeDefined();
      expect(summary.name).toBe('test_summary');
      expect(summary.help).toBe('Test summary metric');
      expect(summary.labelNames).toEqual(['label1']);
      expect(summary.percentiles).toEqual([0.5, 0.9, 0.99]);
      expect(summary.maxAgeSeconds).toBe(600);
      expect(summary.ageBuckets).toBe(5);
    });

    it('should return existing summary if already created', () => {
      const summary1 = service.createSummary({
        name: 'existing_summary',
        help: 'Existing summary',
      });

      const summary2 = service.createSummary({
        name: 'existing_summary',
        help: 'Existing summary',
      });

      expect(summary1).toBe(summary2);
    });

    it('should throw error if metric exists but is not a Summary', () => {
      service.createCounter({
        name: 'mixed_summary_metric',
        help: 'Mixed metric',
      });

      expect(() =>
        service.createSummary({
          name: 'mixed_summary_metric',
          help: 'Mixed metric',
        }),
      ).toThrow('Metric mixed_summary_metric already exists but is not a Summary');
    });
  });

  describe('getMetric', () => {
    it('should return existing metric by name', () => {
      const counter = service.createCounter({
        name: 'get_test_counter',
        help: 'Test counter',
      });

      const retrieved = service.getMetric('get_test_counter');

      expect(retrieved).toBe(counter);
    });

    it('should return undefined for non-existent metric', () => {
      const retrieved = service.getMetric('non_existent_metric');

      expect(retrieved).toBeUndefined();
    });
  });

  describe('registerMetric', () => {
    it('should register an external metric', () => {
      const externalCounter = {
        name: 'external_counter',
        inc: vi.fn(),
      };

      service.registerMetric(externalCounter as any);

      expect(register.registerMetric).toHaveBeenCalledWith(externalCounter);
    });

    it('should skip registration if metric already exists', () => {
      // First create a metric
      service.createCounter({
        name: 'duplicate_metric',
        help: 'Duplicate metric',
      });

      // Try to register an external metric with the same name
      const externalMetric = {
        name: 'duplicate_metric',
        inc: vi.fn(),
      };

      service.registerMetric(externalMetric as any);

      // Should not have called registerMetric for the duplicate
      expect(register.registerMetric).not.toHaveBeenCalledWith(externalMetric);
    });

    it('should throw error if metric has no name', () => {
      const namelessMetric = {
        inc: vi.fn(),
      };

      expect(() => service.registerMetric(namelessMetric as any)).toThrow('Metric must have a name property');
    });
  });

  describe('metric operations', () => {
    it('should increment counter correctly', () => {
      const counter = service.createCounter({
        name: 'ops_test_counter',
        help: 'Counter for operation testing',
      });

      // Verify BEHAVIOR: counter increments work
      counter.inc();
      counter.inc(5);

      expect(counter.inc).toHaveBeenCalledTimes(2);
      // The mock tracks actual values
      expect((counter as any).getValue()).toBe(6);
    });

    it('should set gauge value correctly', () => {
      const gauge = service.createGauge({
        name: 'ops_test_gauge',
        help: 'Gauge for operation testing',
      });

      // Verify BEHAVIOR: gauge set/inc/dec work
      gauge.set(100);
      expect((gauge as any).getValue()).toBe(100);

      gauge.inc(10);
      expect((gauge as any).getValue()).toBe(110);

      gauge.dec(20);
      expect((gauge as any).getValue()).toBe(90);
    });

    it('should observe histogram values correctly', () => {
      const histogram = service.createHistogram({
        name: 'ops_test_histogram',
        help: 'Histogram for operation testing',
        buckets: [0.1, 0.5, 1, 5, 10],
      });

      // Verify BEHAVIOR: histogram observations are recorded
      histogram.observe(0.25);
      histogram.observe(1.5);
      histogram.observe(7);

      expect((histogram as any).getObservations()).toEqual([0.25, 1.5, 7]);
    });

    it('should observe summary values correctly', () => {
      const summary = service.createSummary({
        name: 'ops_test_summary',
        help: 'Summary for operation testing',
        percentiles: [0.5, 0.9, 0.99],
      });

      // Verify BEHAVIOR: summary observations are recorded
      summary.observe(100);
      summary.observe(200);
      summary.observe(150);

      expect((summary as any).getObservations()).toEqual([100, 200, 150]);
    });

    it('should reset metrics correctly', () => {
      const counter = service.createCounter({
        name: 'reset_test_counter',
        help: 'Counter for reset testing',
      });
      const gauge = service.createGauge({
        name: 'reset_test_gauge',
        help: 'Gauge for reset testing',
      });

      counter.inc(100);
      gauge.set(50);

      counter.reset();
      gauge.reset();

      // Verify BEHAVIOR: reset clears values
      expect((counter as any).getValue()).toBe(0);
      expect((gauge as any).getValue()).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle metric creation errors gracefully', () => {
      // Test that creating duplicate metrics with different types throws
      service.createCounter({
        name: 'type_conflict_metric',
        help: 'Type conflict metric',
      });

      expect(() =>
        service.createGauge({
          name: 'type_conflict_metric',
          help: 'Type conflict metric',
        }),
      ).toThrow('Metric type_conflict_metric already exists but is not a Gauge');
    });

    it('should handle missing metric name in registration', () => {
      const namelessMetric = {
        inc: vi.fn(),
      };

      expect(() => service.registerMetric(namelessMetric as any)).toThrow('Metric must have a name property');
    });
  });
});
