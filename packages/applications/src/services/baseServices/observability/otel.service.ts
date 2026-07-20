import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { metrics, trace } from '@opentelemetry/api';

export interface OpenTelemetryConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  metricsEnabled: boolean;
  tracingEnabled: boolean;
}

@Injectable()
export class OpenTelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpenTelemetryService.name);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private meter: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tracer: any;
  private config: OpenTelemetryConfig;

  constructor() {
    this.config = this.getConfigFromEnv();
  }

  async onModuleInit() {
    try {
      if (this.config.metricsEnabled) {
        this.meter = metrics.getMeter(this.config.serviceName, this.config.serviceVersion);
        this.logger.log('OpenTelemetry metrics initialized');
      }

      if (this.config.tracingEnabled) {
        this.tracer = trace.getTracer(this.config.serviceName, this.config.serviceVersion);
        this.logger.log('OpenTelemetry tracing initialized');
      }

      this.logger.log('OpenTelemetry service initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize OpenTelemetry service', error);
    }
  }

  async onModuleDestroy() {
    this.logger.log('OpenTelemetry service shutting down');
  }

  getMeter() {
    return this.meter;
  }

  getTracer() {
    return this.tracer;
  }

  createCounter(name: string, description?: string) {
    if (!this.meter) {
      throw new Error('Metrics not enabled or meter not initialized');
    }
    return this.meter.createCounter(name, {
      description: description || `Counter metric: ${name}`,
    });
  }

  createGauge(name: string, description?: string) {
    if (!this.meter) {
      throw new Error('Metrics not enabled or meter not initialized');
    }
    return this.meter.createGauge(name, {
      description: description || `Gauge metric: ${name}`,
    });
  }

  createHistogram(name: string, description?: string) {
    if (!this.meter) {
      throw new Error('Metrics not enabled or meter not initialized');
    }
    return this.meter.createHistogram(name, {
      description: description || `Histogram metric: ${name}`,
    });
  }

  private getConfigFromEnv(): OpenTelemetryConfig {
    return {
      serviceName: process.env.OTEL_SERVICE_NAME || 'unknown-service',
      serviceVersion: process.env.OTEL_SERVICE_VERSION || '1.0.0',
      environment: process.env.NODE_ENV || 'development',
      metricsEnabled: process.env.OTEL_METRICS_ENABLED === 'true',
      tracingEnabled: process.env.OTEL_TRACES_ENABLED === 'true',
    };
  }
}
