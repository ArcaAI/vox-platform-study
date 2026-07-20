import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import * as os from 'os';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Gauge } from 'prom-client';

import { IMonitoringService, SystemMetrics, KpiDataPoint, IntegrationStatus } from './IMonitoringService';
import { IMetricsService } from '../metrics';
import { IAppSettingsService } from '../_meta/appSettings';

@Injectable()
export class MonitoringService implements IMonitoringService, OnModuleInit {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly subscribers = new Map<string, Map<string, (data: KpiDataPoint) => void>>();
  private readonly kpiHistory = new Map<string, KpiDataPoint[]>();
  private readonly historyRetentionLimitPerMetric: number;
  private readonly systemIntegrations: string[] = [];

  constructor(
    @Inject(IAppSettingsService) private readonly appSettingsService: IAppSettingsService,
    @Inject(IMetricsService) private readonly metricsService: IMetricsService,
    @InjectMetric('system_cpu_usage') private readonly cpuGauge: Gauge<string>,
    @InjectMetric('system_memory_usage') private readonly memoryGauge: Gauge<string>,
  ) {
    this.historyRetentionLimitPerMetric = this.appSettingsService.getValueWithDefault('monitoring.retentionLimit', 1000);

    // Get list of integrated systems from app settings
    this.systemIntegrations = this.appSettingsService.getValueWithDefault('monitoring.integrations', []);

    this.logger.log({
      message: 'Service created',
      service: MonitoringService.name,
      retentionLimit: this.historyRetentionLimitPerMetric,
      integrationsCount: this.systemIntegrations.length,
    });
  }

  async onModuleInit() {
    try {
      // Start system metrics collection
      const collectInterval = this.appSettingsService.getValueWithDefault('monitoring.collectInterval', 15000);

      // Set up periodic system metrics collection
      setInterval(() => {
        this.collectSystemMetrics().catch((error) =>
          this.logger.error({
            message: 'Failed to collect system metrics',
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }, collectInterval);

      this.logger.log({
        message: 'Service initialized',
        service: MonitoringService.name,
        collectIntervalMs: collectInterval,
      });
    } catch (error) {
      this.logger.error({
        message: 'Error during monitoring service initialization',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async collectSystemMetrics(): Promise<void> {
    try {
      const metrics = await this.getSystemMetrics();

      // Update Prometheus metrics
      this.cpuGauge.set(metrics.cpuUsage);
      this.memoryGauge.set(metrics.memoryUsage);

      // Publish metrics for subscribers
      this.publishMetricUpdate('system.cpu', metrics.cpuUsage);
      this.publishMetricUpdate('system.memory', metrics.memoryUsage);
      this.publishMetricUpdate('system.threads', metrics.threadCount);
    } catch (error) {
      this.logger.error({
        message: 'Failed to collect system metrics',
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

      const cpuUsage = 100 - (totalIdle / totalTick) * 100;

      // Get memory usage
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memoryUsage = ((totalMem - freeMem) / totalMem) * 100;

      // Get thread count (simplified estimate)
      const threadCount = process.pid;

      // Get process uptime
      const uptime = process.uptime();

      // Get metrics about processing queues if available
      let processingQueueLength: number | undefined;
      try {
        // This is a placeholder - implement actual queue length retrieval based on your queue system
        processingQueueLength = await this.getQueueLength();
      } catch (err) {
        this.logger.debug({
          message: 'Could not retrieve queue length',
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Get active connections if available
      let activeConnections: number | undefined;
      try {
        // This is a placeholder - implement actual connection count retrieval
        activeConnections = await this.getActiveConnections();
      } catch (err) {
        this.logger.debug({
          message: 'Could not retrieve active connections',
          error: err instanceof Error ? err.message : String(err),
        });
      }

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
    // Placeholder implementation - replace with actual queue length retrieval
    // For example, this could query Redis or RabbitMQ for queue length
    return 0;
  }

  private async getActiveConnections(): Promise<number> {
    // Placeholder implementation - replace with actual connection count retrieval
    // For example, this could be the number of active WebSocket connections
    return 0;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async recordKpi(metricName: string, value: number, metadata?: Record<string, any>): Promise<void> {
    try {
      // Create data point
      const dataPoint: KpiDataPoint = {
        timestamp: new Date(),
        value,
        metadata,
      };

      // Store in history
      if (!this.kpiHistory.has(metricName)) {
        this.kpiHistory.set(metricName, []);
      }

      const metricHistory = this.kpiHistory.get(metricName)!;
      metricHistory.push(dataPoint);

      // Trim history if it exceeds retention limit
      if (metricHistory.length > this.historyRetentionLimitPerMetric) {
        metricHistory.splice(0, metricHistory.length - this.historyRetentionLimitPerMetric);
      }

      // Publish to subscribers
      this.publishMetricUpdate(metricName, value, metadata);

      // If this is a Prometheus metric, update it
      this.updatePrometheusMetric(metricName, value, metadata);

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private updatePrometheusMetric(metricName: string, value: number, metadata?: Record<string, any>): void {
    try {
      // Try to find corresponding Prometheus metric
      const metric = this.metricsService.getMetric(metricName);

      if (!metric) {
        return; // No Prometheus metric with this name
      }

      // Update the metric appropriately based on its type
      if ('inc' in metric) {
        // It's a Counter - increment by the value
        if (metadata) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore - metrics methods may accept label values
          metric.inc(metadata, value);
        } else {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          metric.inc(value);
        }
      } else if ('set' in metric) {
        // It's a Gauge - set the value
        if (metadata) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore - metrics methods may accept label values
          metric.set(metadata, value);
        } else {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          metric.set(value);
        }
      } else if ('observe' in metric) {
        // It's a Histogram or Summary - observe the value
        if (metadata) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore - metrics methods may accept label values
          metric.observe(metadata, value);
        } else {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          metric.observe(value);
        }
      }
    } catch (error) {
      this.logger.warn({
        message: 'Failed to update Prometheus metric',
        metricName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private publishMetricUpdate(metricName: string, value: number, metadata?: Record<string, any>): void {
    if (!this.subscribers.has(metricName)) {
      return; // No subscribers for this metric
    }

    const dataPoint: KpiDataPoint = {
      timestamp: new Date(),
      value,
      metadata,
    };

    const subscribers = this.subscribers.get(metricName)!;
    subscribers.forEach((callback) => {
      try {
        callback(dataPoint);
      } catch (error) {
        this.logger.error({
          message: 'Error in metric subscriber',
          metricName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async getKpiHistory(metricName: string, startTime: Date, endTime: Date, aggregation?: 'avg' | 'sum' | 'max' | 'min'): Promise<KpiDataPoint[]> {
    try {
      if (!this.kpiHistory.has(metricName)) {
        return [];
      }

      // Filter data points by time range
      const metricHistory = this.kpiHistory.get(metricName)!;
      const filteredPoints = metricHistory.filter((point) => point.timestamp >= startTime && point.timestamp <= endTime);

      // Apply aggregation if requested
      if (aggregation && filteredPoints.length > 0) {
        return this.aggregateDataPoints(filteredPoints, aggregation);
      }

      return filteredPoints;
    } catch (error) {
      this.logger.error({
        message: 'Failed to get KPI history',
        metricName,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        aggregation,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private aggregateDataPoints(dataPoints: KpiDataPoint[], aggregation: 'avg' | 'sum' | 'max' | 'min'): KpiDataPoint[] {
    // This is a simplified aggregation - in a real implementation,
    // you might want to group by time buckets first

    if (dataPoints.length === 0) {
      return [];
    }

    let value: number;
    switch (aggregation) {
      case 'avg':
        value = dataPoints.reduce((sum, point) => sum + point.value, 0) / dataPoints.length;
        break;
      case 'sum':
        value = dataPoints.reduce((sum, point) => sum + point.value, 0);
        break;
      case 'max':
        value = Math.max(...dataPoints.map((point) => point.value));
        break;
      case 'min':
        value = Math.min(...dataPoints.map((point) => point.value));
        break;
    }

    return [
      {
        timestamp: dataPoints[0].timestamp, // Use first timestamp or calculate mid-point
        value,
      },
    ];
  }

  async checkIntegrationStatus(): Promise<IntegrationStatus[]> {
    try {
      const results: IntegrationStatus[] = [];

      // Check status of each configured integration
      for (const integrationName of this.systemIntegrations) {
        try {
          // This is a placeholder - implement actual status check for each integration
          const startTime = Date.now();
          const isConnected = await this.checkIntegrationConnection(integrationName);
          const latency = Date.now() - startTime;

          results.push({
            name: integrationName,
            isConnected,
            lastChecked: new Date(),
            latency,
            errorCount: isConnected ? 0 : 1,
          });
        } catch (error) {
          this.logger.error({
            message: 'Failed to check integration status',
            integrationName,
            error: error instanceof Error ? error.message : String(error),
          });
          results.push({
            name: integrationName,
            isConnected: false,
            lastChecked: new Date(),
            errorCount: 1,
            details: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      }

      return results;
    } catch (error) {
      this.logger.error({
        message: 'Failed to check integration status',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async checkIntegrationConnection(_integrationName: string): Promise<boolean> {
    // Placeholder implementation - replace with actual integration status check
    // This could ping a database, API, or other service
    return true;
  }

  subscribeToMetric(metricName: string, callback: (data: KpiDataPoint) => void): string {
    try {
      if (!this.subscribers.has(metricName)) {
        this.subscribers.set(metricName, new Map());
      }

      const subscribers = this.subscribers.get(metricName)!;
      const subscriptionId = `${metricName}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;

      subscribers.set(subscriptionId, callback);
      this.logger.debug({
        message: 'Created subscription to metric',
        metricName,
        subscriptionId,
      });

      return subscriptionId;
    } catch (error) {
      this.logger.error({
        message: 'Failed to subscribe to metric',
        metricName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  unsubscribeFromMetric(subscriptionId: string): void {
    try {
      // Parse metric name from subscription ID
      const metricName = subscriptionId.split('-')[0];

      if (!this.subscribers.has(metricName)) {
        this.logger.warn({
          message: 'No subscribers found for metric',
          metricName,
        });
        return;
      }

      const subscribers = this.subscribers.get(metricName)!;
      const removed = subscribers.delete(subscriptionId);

      if (removed) {
        this.logger.debug({
          message: 'Removed subscription',
          subscriptionId,
          metricName,
        });

        // Clean up empty subscriber maps
        if (subscribers.size === 0) {
          this.subscribers.delete(metricName);
        }
      } else {
        this.logger.warn({
          message: 'Subscription not found',
          subscriptionId,
        });
      }
    } catch (error) {
      this.logger.error({
        message: 'Failed to unsubscribe from metric',
        subscriptionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
