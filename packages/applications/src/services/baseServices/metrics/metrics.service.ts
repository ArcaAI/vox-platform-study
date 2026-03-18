import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { Counter, Gauge, Histogram, Summary, register, collectDefaultMetrics } from 'prom-client';
import { InjectMetric, makeHistogramProvider } from '@willsoto/nestjs-prometheus';
import { IMetricsService, MetricOptions, HistogramOptions, SummaryOptions } from './IMetricsService';
import { IAppSettingsService } from '../_meta/appSettings';

@Injectable()
export class MetricsService implements IMetricsService, OnModuleInit {
    private readonly logger = new Logger(MetricsService.name);
    private readonly metrics = new Map<string, Counter<string> | Gauge<string> | Histogram<string> | Summary<string>>();
    private readonly defaultMetricsInterval: number;

    constructor(
        @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    ) {
        // Get metrics interval from app settings or use default
        this.defaultMetricsInterval = this.appSettingsService.getValueWithDefault('metrics.defaultMetricsInterval', 10000);

        this.logger.log({
            message: 'Service created',
            service: MetricsService.name,
            defaultMetricsInterval: this.defaultMetricsInterval,
        });
    }

    async onModuleInit() {
        try {
            // Configure default metrics collection with default interval
            collectDefaultMetrics({
                register: register,
                prefix: this.appSettingsService.getValueWithDefault('metrics.prefix', 'arca_'),
            });

            // Create standard application metrics
            this.createCounter({
                name: 'http_requests_total',
                help: 'Total number of HTTP requests',
                labelNames: ['method', 'path', 'status'],
            });

            this.createHistogram({
                name: 'http_request_duration_seconds',
                help: 'HTTP request duration in seconds',
                labelNames: ['method', 'path', 'status'],
                buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
            });

            this.createGauge({
                name: 'active_connections',
                help: 'Number of active connections',
            });

            this.logger.log({
                message: 'Service initialized',
                service: MetricsService.name,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error during metrics service initialization',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
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
                name: options.name,
                help: options.help,
                labelNames: options.labelNames || [],
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
                name: options.name,
                help: options.help,
                labelNames: options.labelNames || [],
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
                name: options.name,
                help: options.help,
                labelNames: options.labelNames || [],
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
                name: options.name,
                help: options.help,
                labelNames: options.labelNames || [],
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
            // @ts-ignore - accessing internal property to get metric name
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
}
