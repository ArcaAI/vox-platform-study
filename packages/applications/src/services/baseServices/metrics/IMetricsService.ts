import { Counter, Gauge, Histogram, Summary } from 'prom-client';

/**
 * Types of metrics supported by Prometheus
 */
export enum MetricType {
  COUNTER = 'counter',
  GAUGE = 'gauge',
  HISTOGRAM = 'histogram',
  SUMMARY = 'summary',
}

/**
 * Common options for all metric types
 */
export interface MetricOptions {
  name: string;
  help: string;
  labelNames?: string[];
}

/**
 * Histogram-specific options
 */
export interface HistogramOptions extends MetricOptions {
  buckets?: number[];
}

/**
 * Summary-specific options
 */
export interface SummaryOptions extends MetricOptions {
  percentiles?: number[];
  maxAgeSeconds?: number;
  ageBuckets?: number;
}

/**
 * Interface for metrics service that provides Prometheus metrics
 */
export interface IMetricsService {
  /**
   * Create a counter metric
   * @param options Configuration options for the counter
   * @returns The created counter instance
   */
  createCounter(options: MetricOptions): Counter<string>;

  /**
   * Create a gauge metric
   * @param options Configuration options for the gauge
   * @returns The created gauge instance
   */
  createGauge(options: MetricOptions): Gauge<string>;

  /**
   * Create a histogram metric
   * @param options Configuration options for the histogram
   * @returns The created histogram instance
   */
  createHistogram(options: HistogramOptions): Histogram<string>;

  /**
   * Create a summary metric
   * @param options Configuration options for the summary
   * @returns The created summary instance
   */
  createSummary(options: SummaryOptions): Summary<string>;

  /**
   * Get an existing metric by name
   * @param name Name of the metric to retrieve
   * @returns The metric instance or undefined if not found
   */
  getMetric(name: string): Counter<string> | Gauge<string> | Histogram<string> | Summary<string> | undefined;

  /**
   * Register a custom metric created outside the service
   * @param metric The metric instance to register
   */
  registerMetric(metric: Counter<string> | Gauge<string> | Histogram<string> | Summary<string>): void;
}

export const IMetricsService = Symbol('IMetricsService');
