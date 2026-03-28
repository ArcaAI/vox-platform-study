import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Counter, Gauge, Histogram, Summary, register, collectDefaultMetrics } from 'prom-client';
import { IMetricsService, MetricOptions, HistogramOptions, SummaryOptions } from '../metrics/IMetricsService';

@Injectable()
export class SimplifiedMetricsService implements IMetricsService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SimplifiedMetricsService.name);
  private readonly metrics = new Map<string, Counter<string> | Gauge<string> | Histogram<string> | Summary<string>>();
  private readonly serviceName: string;
  private readonly metricsPrefix: string;

  constructor() {
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    this.serviceName = process.env.OTEL_SERVICE_NAME || 'hope-service';
    // Sanitize service name for Prometheus metric naming (replace hyphens with underscores)
    const sanitizedServiceName = this.serviceName.replace(/-/g, '_');
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    this.metricsPrefix = process.env.METRICS_PREFIX || `${sanitizedServiceName}_`;
    this.logger.log({
      message: 'Service created',
      service: SimplifiedMetricsService.name,
      serviceName: this.serviceName,
      metricsPrefix: this.metricsPrefix,
    });
  }

  async onModuleInit() {
    try {
      // Configure default metrics collection with service prefix
      collectDefaultMetrics({
        register: register,
        prefix: this.metricsPrefix,
        labels: {
          service: this.serviceName,
          // eslint-disable-next-line turbo/no-undeclared-env-vars
          version: process.env.OTEL_SERVICE_VERSION || '1.0.0',
          environment: process.env.NODE_ENV || 'development',
        },
      });

      // Create standard application metrics
      this.initializeStandardMetrics();

      this.logger.log({
        message: 'Service initialized',
        service: SimplifiedMetricsService.name,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error during service initialization',
        service: SimplifiedMetricsService.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async onModuleDestroy() {
    this.logger.log({
      message: 'Service shutting down',
      service: SimplifiedMetricsService.name,
    });
    // Clear all custom metrics
    this.metrics.clear();
  }

  private initializeStandardMetrics(): void {
    // HTTP request metrics
    this.createCounter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status', 'service'],
    });

    this.createHistogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path', 'status', 'service'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
    });

    // System metrics
    this.createGauge({
      name: 'system_cpu_usage_percent',
      help: 'Current CPU usage percentage',
      labelNames: ['service'],
    });

    this.createGauge({
      name: 'system_memory_usage_percent',
      help: 'Current memory usage percentage',
      labelNames: ['service'],
    });

    this.createGauge({
      name: 'active_connections_count',
      help: 'Number of active connections',
      labelNames: ['service'],
    });

    // Business metrics
    this.createCounter({
      name: 'business_operations_total',
      help: 'Total number of business operations',
      labelNames: ['operation', 'status', 'service'],
    });

    this.createHistogram({
      name: 'business_operation_duration_seconds',
      help: 'Business operation duration in seconds',
      labelNames: ['operation', 'service'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
    });
  }

  createCounter(options: MetricOptions): Counter<string> {
    try {
      const existingMetric = this.getMetric(options.name);
      if (existingMetric) {
        if (!(existingMetric instanceof Counter)) {
          throw new Error(`Metric ${options.name} already exists but is not a Counter`);
        }
        return existingMetric;
      }

      const counter = new Counter({
        name: this.addPrefix(options.name),
        help: options.help,
        labelNames: this.addServiceLabel(options.labelNames || []),
        registers: [register],
      });

      this.metrics.set(options.name, counter);
      this.logger.debug({
        message: 'Created counter metric',
        metricName: options.name,
        labelNames: options.labelNames,
      });
      return counter;
    } catch (error) {
      this.logger.error({
        message: 'Failed to create counter metric',
        metricName: options.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  createGauge(options: MetricOptions): Gauge<string> {
    try {
      const existingMetric = this.getMetric(options.name);
      if (existingMetric) {
        if (!(existingMetric instanceof Gauge)) {
          throw new Error(`Metric ${options.name} already exists but is not a Gauge`);
        }
        return existingMetric;
      }

      const gauge = new Gauge({
        name: this.addPrefix(options.name),
        help: options.help,
        labelNames: this.addServiceLabel(options.labelNames || []),
        registers: [register],
      });

      this.metrics.set(options.name, gauge);
      this.logger.debug({
        message: 'Created gauge metric',
        metricName: options.name,
        labelNames: options.labelNames,
      });
      return gauge;
    } catch (error) {
      this.logger.error({
        message: 'Failed to create gauge metric',
        metricName: options.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  createHistogram(options: HistogramOptions): Histogram<string> {
    try {
      const existingMetric = this.getMetric(options.name);
      if (existingMetric) {
        if (!(existingMetric instanceof Histogram)) {
          throw new Error(`Metric ${options.name} already exists but is not a Histogram`);
        }
        return existingMetric;
      }

      const histogram = new Histogram({
        name: this.addPrefix(options.name),
        help: options.help,
        labelNames: this.addServiceLabel(options.labelNames || []),
        buckets: options.buckets,
        registers: [register],
      });

      this.metrics.set(options.name, histogram);
      this.logger.debug({
        message: 'Created histogram metric',
        metricName: options.name,
        labelNames: options.labelNames,
        buckets: options.buckets,
      });
      return histogram;
    } catch (error) {
      this.logger.error({
        message: 'Failed to create histogram metric',
        metricName: options.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  createSummary(options: SummaryOptions): Summary<string> {
    try {
      const existingMetric = this.getMetric(options.name);
      if (existingMetric) {
        if (!(existingMetric instanceof Summary)) {
          throw new Error(`Metric ${options.name} already exists but is not a Summary`);
        }
        return existingMetric;
      }

      const summary = new Summary({
        name: this.addPrefix(options.name),
        help: options.help,
        labelNames: this.addServiceLabel(options.labelNames || []),
        percentiles: options.percentiles,
        maxAgeSeconds: options.maxAgeSeconds,
        ageBuckets: options.ageBuckets,
        registers: [register],
      });

      this.metrics.set(options.name, summary);
      this.logger.debug({
        message: 'Created summary metric',
        metricName: options.name,
        labelNames: options.labelNames,
        percentiles: options.percentiles,
      });
      return summary;
    } catch (error) {
      this.logger.error({
        message: 'Failed to create summary metric',
        metricName: options.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  getMetric(name: string): Counter<string> | Gauge<string> | Histogram<string> | Summary<string> | undefined {
    return this.metrics.get(name);
  }

  registerMetric(metric: Counter<string> | Gauge<string> | Histogram<string> | Summary<string>): void {
    try {
      // @ts-expect-error - accessing internal property to get metric name
      const name = metric.name;
      if (!name) {
        throw new Error('Metric must have a name property');
      }

      if (this.metrics.has(name)) {
        this.logger.warn({
          message: 'Metric already registered, skipping',
          metricName: name,
        });
        return;
      }

      register.registerMetric(metric);
      this.metrics.set(name, metric);
      this.logger.debug({
        message: 'Registered external metric',
        metricName: name,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to register external metric',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Helper methods
  private addPrefix(name: string): string {
    // Sanitize metric name to ensure it's valid for Prometheus
    const sanitizedName = name.replace(/-/g, '_').replace(/[^a-zA-Z0-9:_]/g, '_');
    return sanitizedName.startsWith(this.metricsPrefix) ? sanitizedName : `${this.metricsPrefix}${sanitizedName}`;
  }

  private addServiceLabel(labelNames: string[]): string[] {
    return labelNames.includes('service') ? labelNames : [...labelNames, 'service'];
  }

  // Additional convenience methods
  incrementCounter(name: string, labels?: Record<string, string>): void {
    const metric = this.getMetric(name);
    if (metric && 'inc' in metric) {
      const labelsWithService = { ...labels, service: this.serviceName };
      metric.inc(labelsWithService);
    }
  }

  setGauge(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.getMetric(name);
    if (metric && 'set' in metric) {
      const labelsWithService = { ...labels, service: this.serviceName };
      metric.set(labelsWithService, value);
    }
  }

  observeHistogram(name: string, value: number, labels?: Record<string, string>): void {
    const metric = this.getMetric(name);
    if (metric && 'observe' in metric) {
      const labelsWithService = { ...labels, service: this.serviceName };
      metric.observe(labelsWithService, value);
    }
  }
}
