/**
 * Interface representing a system resource metrics
 */
export interface SystemMetrics {
  cpuUsage: number;
  memoryUsage: number;
  threadCount: number;
  uptime: number;
  processingQueueLength?: number;
  activeConnections?: number;
}

/**
 * Interface representing an individual KPI data point
 */
export interface KpiDataPoint {
  timestamp: Date;
  value: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any>;
}

/**
 * Interface for integration status information
 */
export interface IntegrationStatus {
  name: string;
  isConnected: boolean;
  lastChecked: Date;
  latency?: number;
  errorCount?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  details?: Record<string, any>;
}

/**
 * Interface for monitoring service that provides system monitoring and KPI tracking
 */
export interface IMonitoringService {
  /**
   * Get current system resource metrics
   * @returns Current system metrics
   */
  getSystemMetrics(): Promise<SystemMetrics>;

  /**
   * Record a KPI data point for a specific metric
   * @param metricName Name of the KPI metric
   * @param value Value to record
   * @param metadata Optional metadata about this data point
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recordKpi(metricName: string, value: number, metadata?: Record<string, any>): Promise<void>;

  /**
   * Get historical KPI data for a specific metric
   * @param metricName Name of the KPI metric
   * @param startTime Start time for the query period
   * @param endTime End time for the query period
   * @param aggregation Optional aggregation method (e.g., 'avg', 'sum', 'max')
   * @returns Array of KPI data points over the requested time period
   */
  getKpiHistory(metricName: string, startTime: Date, endTime: Date, aggregation?: 'avg' | 'sum' | 'max' | 'min'): Promise<KpiDataPoint[]>;

  /**
   * Check status of all integrated systems
   * @returns Status information for all integrations
   */
  checkIntegrationStatus(): Promise<IntegrationStatus[]>;

  /**
   * Register a real-time monitoring subscriber
   * @param metricName Name of the metric to subscribe to
   * @param callback Function to be called when new data is available
   * @returns Subscription ID that can be used to unsubscribe
   */
  subscribeToMetric(metricName: string, callback: (data: KpiDataPoint) => void): string;

  /**
   * Unsubscribe from real-time monitoring updates
   * @param subscriptionId ID of the subscription to cancel
   */
  unsubscribeFromMetric(subscriptionId: string): void;
}

export const IMonitoringService = Symbol('IMonitoringService');
