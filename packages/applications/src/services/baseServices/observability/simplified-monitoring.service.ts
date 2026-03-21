import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import * as os from 'os';
import { IMonitoringService, SystemMetrics, KpiDataPoint, IntegrationStatus } from '../monitoring/IMonitoringService';
import { IMetricsService } from '../metrics/IMetricsService';

@Injectable()
export class SimplifiedMonitoringService implements IMonitoringService, OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(SimplifiedMonitoringService.name);
    private readonly serviceName: string;
    private readonly environment: string;
    private collectInterval: NodeJS.Timeout | null = null;

    // System metrics gauges
    private cpuGauge: any;
    private memoryGauge: any;
    private connectionsGauge: any;

    constructor(
        @Inject(IMetricsService) private readonly metricsService: IMetricsService,
    ) {
        this.serviceName = process.env.OTEL_SERVICE_NAME || 'hope-service';
        this.environment = process.env.NODE_ENV || 'development';
        this.logger.log({
            message: 'Service created',
            service: SimplifiedMonitoringService.name,
            serviceName: this.serviceName,
            environment: this.environment,
        });
    }

    async onModuleInit() {
        try {
            // Create system metrics gauges
            this.cpuGauge = this.metricsService.getMetric('system_cpu_usage_percent') ||
                          this.metricsService.createGauge({
                              name: 'system_cpu_usage_percent',
                              help: 'Current CPU usage percentage',
                              labelNames: ['service']
                          });

            this.memoryGauge = this.metricsService.getMetric('system_memory_usage_percent') ||
                             this.metricsService.createGauge({
                                 name: 'system_memory_usage_percent',
                                 help: 'Current memory usage percentage',
                                 labelNames: ['service']
                             });

            this.connectionsGauge = this.metricsService.getMetric('active_connections_count') ||
                                  this.metricsService.createGauge({
                                      name: 'active_connections_count',
                                      help: 'Number of active connections',
                                      labelNames: ['service']
                                  });

            // Start system metrics collection
            const intervalMs = parseInt(process.env.METRICS_COLLECT_INTERVAL || '15000');
            this.collectInterval = setInterval(() => {
                this.collectAndUpdateSystemMetrics().catch((error) =>
                    this.logger.error({
                        message: 'Failed to collect system metrics',
                        error: error instanceof Error ? error.message : String(error),
                    })
                );
            }, intervalMs);

            this.logger.log({
                message: 'Service initialized',
                service: SimplifiedMonitoringService.name,
                collectIntervalMs: intervalMs,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error during service initialization',
                service: SimplifiedMonitoringService.name,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async onModuleDestroy() {
        if (this.collectInterval) {
            clearInterval(this.collectInterval);
            this.collectInterval = null;
        }
        this.logger.log({
            message: 'Service shutting down',
            service: SimplifiedMonitoringService.name,
        });
    }

    private async collectAndUpdateSystemMetrics(): Promise<void> {
        try {
            const metrics = await this.getSystemMetrics();

            // Update Prometheus metrics with service label
            const labels = { service: this.serviceName };

            if (this.cpuGauge && 'set' in this.cpuGauge) {
                this.cpuGauge.set(labels, metrics.cpuUsage);
            }

            if (this.memoryGauge && 'set' in this.memoryGauge) {
                this.memoryGauge.set(labels, metrics.memoryUsage);
            }

            if (this.connectionsGauge && 'set' in this.connectionsGauge && metrics.activeConnections !== undefined) {
                this.connectionsGauge.set(labels, metrics.activeConnections);
            }

            this.logger.debug({
                message: 'System metrics updated',
                cpuUsagePercent: parseFloat(metrics.cpuUsage.toFixed(2)),
                memoryUsagePercent: parseFloat(metrics.memoryUsage.toFixed(2)),
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to collect and update system metrics',
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async getSystemMetrics(): Promise<SystemMetrics> {
        try {
            // Calculate CPU usage
            const cpus = os.cpus();
            let totalIdle = 0;
            let totalTick = 0;

            cpus.forEach((cpu) => {
                for (const type in cpu.times) {
                    totalTick += cpu.times[type];
                }
                totalIdle += cpu.times.idle;
            });

            const cpuUsage = totalTick === 0 ? 0 : Math.max(0, Math.min(100, 100 - (totalIdle / totalTick) * 100));

            // Get memory usage
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const memoryUsage = totalMem === 0 ? 0 : ((totalMem - freeMem) / totalMem) * 100;

            // Get thread count (approximate using process info)
            const threadCount = process.pid;

            // Get process uptime
            const uptime = process.uptime();

            // For queue length and connections, we'll use placeholders that can be overridden
            const processingQueueLength = await this.getQueueLength();
            const activeConnections = await this.getActiveConnections();

            return {
                cpuUsage,
                memoryUsage,
                threadCount,
                uptime,
                processingQueueLength,
                activeConnections,
            };
        } catch (error) {
            this.logger.error({
                message: 'Failed to get system metrics',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    private async getQueueLength(): Promise<number> {
        // Placeholder - implement based on your queue system (Redis, BullMQ, etc.)
        try {
            // This could query Redis or your queue system
            return 0;
        } catch (error) {
            this.logger.debug({
                message: 'Could not retrieve queue length',
                error: error instanceof Error ? error.message : String(error),
            });
            return 0;
        }
    }

    private async getActiveConnections(): Promise<number> {
        // Placeholder - implement based on your connection tracking
        try {
            // This could track WebSocket connections, database connections, etc.
            return 0;
        } catch (error) {
            this.logger.debug({
                message: 'Could not retrieve active connections',
                error: error instanceof Error ? error.message : String(error),
            });
            return 0;
        }
    }

    async recordKpi(metricName: string, value: number, metadata?: Record<string, any>): Promise<void> {
        try {
            // Instead of storing KPI history locally, we'll use Prometheus metrics
            // This provides better scalability and integrates with Grafana

            // Try to find or create a gauge for this KPI
            let metric = this.metricsService.getMetric(metricName);

            if (!metric) {
                // Create a new gauge for this KPI
                metric = this.metricsService.createGauge({
                    name: metricName,
                    help: `KPI metric: ${metricName}`,
                    labelNames: ['service', 'type', ...(metadata ? Object.keys(metadata) : [])],
                });
            }

            // Update the metric with service and metadata labels
            const labels = {
                service: this.serviceName,
                type: 'kpi',
                ...metadata,
            };

            if (metric && 'set' in metric) {
                metric.set(labels, value);
            }

            this.logger.debug({
                message: 'Recorded KPI',
                metricName,
                value,
                hasMetadata: !!metadata,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to record KPI',
                metricName,
                value,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    async getKpiHistory(
        metricName: string,
        startTime: Date,
        endTime: Date,
        aggregation?: 'avg' | 'sum' | 'max' | 'min'
    ): Promise<KpiDataPoint[]> {
        // For historical data, we'll recommend using Prometheus queries through Grafana
        // This is more scalable than storing data locally
        this.logger.warn({
            message: 'KPI history should be queried from Prometheus',
            metricName,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            recommendation: 'Use Prometheus/Grafana for historical KPI data queries',
        });

        return [];
    }

    async checkIntegrationStatus(): Promise<IntegrationStatus[]> {
        const integrations: IntegrationStatus[] = [];

        try {
            // Check Prometheus metrics endpoint
            integrations.push({
                name: 'prometheus_metrics',
                isConnected: true,
                lastChecked: new Date(),
                latency: 0,
                details: {
                    endpoint: '/metrics',
                    service: this.serviceName,
                },
            });

            // Check logging system
            integrations.push({
                name: 'logging_system',
                isConnected: true,
                lastChecked: new Date(),
                latency: 0,
                details: {
                    level: process.env.LOG_LEVEL || 'info',
                    fileEnabled: process.env.LOG_FILE_ENABLED || 'false',
                },
            });

            // Add checks for other systems as needed
            // Redis, Database, External APIs, etc.

        } catch (error) {
            this.logger.error({
                message: 'Failed to check integration status',
                error: error instanceof Error ? error.message : String(error),
            });
        }

        return integrations;
    }

    subscribeToMetric(metricName: string, callback: (data: KpiDataPoint) => void): string {
        // For real-time monitoring, recommend using Grafana alerts or Prometheus alerting
        const subscriptionId = `${metricName}_${Date.now()}`;

        this.logger.warn({
            message: 'Real-time metric subscription not implemented',
            metricName,
            subscriptionId,
            recommendation: 'Use Grafana alerts or Prometheus Alertmanager for real-time monitoring',
        });

        return subscriptionId;
    }

    unsubscribeFromMetric(subscriptionId: string): void {
        this.logger.debug({
            message: 'Unsubscribed from metric',
            subscriptionId,
        });
    }

    // Additional utility methods
    async recordHttpRequest(method: string, path: string, status: number, duration: number): Promise<void> {
        try {
            // Record HTTP request count
            const requestCounter = this.metricsService.getMetric('http_requests_total');
            if (requestCounter && 'inc' in requestCounter) {
                requestCounter.inc({
                    method,
                    path,
                    status: status.toString(),
                    service: this.serviceName,
                });
            }

            // Record HTTP request duration
            const durationHistogram = this.metricsService.getMetric('http_request_duration_seconds');
            if (durationHistogram && 'observe' in durationHistogram) {
                durationHistogram.observe({
                    method,
                    path,
                    status: status.toString(),
                    service: this.serviceName,
                }, duration);
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to record HTTP request metrics',
                method,
                path,
                status,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async recordBusinessOperation(operation: string, status: 'success' | 'error', duration?: number): Promise<void> {
        try {
            // Record business operation count
            const operationCounter = this.metricsService.getMetric('business_operations_total');
            if (operationCounter && 'inc' in operationCounter) {
                operationCounter.inc({
                    operation,
                    status,
                    service: this.serviceName,
                });
            }

            // Record business operation duration if provided
            if (duration !== undefined) {
                const durationHistogram = this.metricsService.getMetric('business_operation_duration_seconds');
                if (durationHistogram && 'observe' in durationHistogram) {
                    durationHistogram.observe({
                        operation,
                        service: this.serviceName,
                    }, duration);
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to record business operation metrics',
                operation,
                status,
                duration,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}