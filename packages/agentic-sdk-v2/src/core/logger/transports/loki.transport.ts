/**
 * @arcaai/vox - Loki Transport
 *
 * Transport for Grafana Loki with support for:
 * - Batch log shipping
 * - Label-based filtering
 * - Structured metadata
 * - OpenTelemetry trace correlation
 *
 * @see https://grafana.com/docs/loki/latest/api/
 */

import type { ILogTransport, LogEntry, LokiTransportConfig, LogLevel } from '../types';
import { LOG_LEVEL_VALUES } from '../types';
import { safeStringify } from '../utils';

/**
 * Loki push format
 * @see https://grafana.com/docs/loki/latest/reference/loki-http-api/#ingest-logs
 */
interface LokiStream {
  stream: Record<string, string>;
  values: [string, string, Record<string, unknown>?][];
}

interface LokiPushRequest {
  streams: LokiStream[];
}

/**
 * Loki transport implementation.
 *
 * **TASK-278 — gated activation.**
 * Mirrors the `HighlightTransport` (TASK-266 W0-2) defence-in-depth pattern.
 * Shipping consultation telemetry to a Loki endpoint is a HIPAA exposure
 * unless the operator has explicitly opted in to a vetted endpoint. This
 * transport therefore refuses to initialise unless ALL of the following are
 * true:
 *
 *   1. `process.env.NODE_ENV !== 'production'` (or `process` is undefined).
 *   2. The caller explicitly opted in via `config.enabled === true`.
 *   3. A non-empty `config.url` (Loki push endpoint) is supplied.
 *
 * If any gate fails the transport enters a permanently-disabled state where
 * `initialize()` is a no-op (no flush timer is scheduled) and `log()` is a
 * hard no-op — no in-memory queue, no retries — so a misconfigured production
 * deploy cannot silently buffer PHI in memory that a later runtime gate-flip
 * could ship to Loki.
 *
 * `SDKLogger.dispatch()` already pre-redacts every entry via `redactPHI` so
 * the primary in-process PHI safety boundary is upstream of this transport;
 * this activation gate is the second, fail-closed layer.
 */
export class LokiTransport implements ILogTransport {
  readonly name = 'loki';
  private config: LokiTransportConfig;
  private level: LogLevel;
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  /**
   * Once true, this transport will never POST another log and will not even
   * queue them. Set when the TASK-278 gate refuses activation (production env,
   * not opted in, or missing endpoint).
   */
  private permanentlyDisabled = false;

  constructor(config: LokiTransportConfig) {
    this.config = {
      batchIntervalMs: 5000,
      maxBatchSize: 100,
      ...config,
    };
    // `config.level` is a pre-existing untyped extension carried over from the
    // SDK's original transport contract. Keeping the runtime behaviour intact.
    this.level = (config as LokiTransportConfig & { level?: LogLevel }).level || 'info';
    if (!LokiTransport.isAllowedToActivate(config)) {
      this.permanentlyDisabled = true;
      this.buffer = [];
    }
  }

  /**
   * TASK-278 activation predicate.
   *
   * Pure & static so `SDKLogger.initializeTransports()` can also call it
   * to skip constructing the transport entirely.
   */
  static isAllowedToActivate(config: LokiTransportConfig): boolean {
    if (!config.enabled) return false;
    if (!config.url || config.url.trim().length === 0) return false;
    // `process` may be undefined in some browser bundles — treat as non-prod.
    const env = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
    if (env === 'production') return false;
    return true;
  }

  async initialize(): Promise<void> {
    if (this.permanentlyDisabled) return;
    // Start batch flush timer
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[LokiTransport] Flush error:', err);
      });
    }, this.config.batchIntervalMs);
  }

  /**
   * Check if level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.level];
  }

  /**
   * Log entry (buffers for batch sending).
   *
   * TASK-278: when the transport is permanently disabled (production env,
   * not opted in, or missing endpoint) this is a hard no-op — we do not even
   * queue the entry, so a misconfigured deploy cannot silently buffer PHI in
   * memory that a later runtime gate-flip could flush to Loki.
   */
  log(entry: LogEntry): void {
    if (this.permanentlyDisabled) return;
    if (!this.shouldLog(entry.level)) return;

    this.buffer.push(entry);

    // Flush if buffer is full
    if (this.buffer.length >= (this.config.maxBatchSize || 100)) {
      this.flush().catch((err) => {
        console.error('[LokiTransport] Flush error:', err);
      });
    }
  }

  /**
   * Build Loki labels from log entry
   */
  private buildLabels(entry: LogEntry): Record<string, string> {
    const labels: Record<string, string> = {
      ...this.config.labels,
      level: entry.level,
    };

    // Add context as label if present
    if (entry.context) {
      labels.context = entry.context;
    }

    // Add environment
    if (entry.resource?.environment) {
      labels.env = entry.resource.environment;
    }

    // Add service name
    if (entry.resource?.serviceName) {
      labels.service = entry.resource.serviceName;
    }

    // Add component if present
    if (entry.operation?.component) {
      labels.component = entry.operation.component;
    }

    // Add operation name if present (be careful with high cardinality)
    // Only add if explicitly configured
    if (this.config.labels?.include_operation && entry.operation?.operation) {
      labels.operation = entry.operation.operation;
    }

    return labels;
  }

  /**
   * Build structured metadata for Loki
   * @see https://grafana.com/docs/loki/latest/reference/loki-http-api/#structured-metadata
   */
  private buildStructuredMetadata(entry: LogEntry): Record<string, unknown> {
    const metadata: Record<string, unknown> = {};

    // Correlation context
    if (entry.correlation?.correlationId) metadata.correlation_id = entry.correlation.correlationId;
    if (entry.correlation?.requestId) metadata.request_id = entry.correlation.requestId;
    if (entry.correlation?.sessionId) metadata.session_id = entry.correlation.sessionId;

    // Trace context (critical for Grafana Tempo correlation)
    if (entry.trace?.traceId) metadata.trace_id = entry.trace.traceId;
    if (entry.trace?.spanId) metadata.span_id = entry.trace.spanId;

    // User context
    if (entry.user?.userId) metadata.user_id = entry.user.userId;
    if (entry.user?.tenantId) metadata.tenant_id = entry.user.tenantId;
    if (entry.user?.doctorId) metadata.doctor_id = entry.user.doctorId;
    if (entry.user?.patientId) metadata.patient_id = entry.user.patientId;

    // Operation context
    if (entry.operation) {
      if (entry.operation.operation) metadata.operation = entry.operation.operation;
      if (entry.operation.durationMs !== undefined) metadata.duration_ms = entry.operation.durationMs;
      if (entry.operation.success !== undefined) metadata.success = entry.operation.success;
    }

    // HTTP context
    if (entry.http) {
      if (entry.http.method) metadata.http_method = entry.http.method;
      if (entry.http.url) metadata.http_url = entry.http.url;
      if (entry.http.statusCode) metadata.http_status = entry.http.statusCode;
      if (entry.http.responseTimeMs !== undefined) metadata.http_duration_ms = entry.http.responseTimeMs;
    }

    // Error context
    if (entry.error) {
      if (entry.error.code) metadata.error_code = entry.error.code;
      if (entry.error.name) metadata.error_name = entry.error.name;
    }

    // SDK context
    if (entry.sdk?.consultationId) metadata.consultation_id = entry.sdk.consultationId;
    if (entry.sdk?.modelId) metadata.model_id = entry.sdk.modelId;

    // Additional attributes
    if (entry.attributes) {
      for (const [key, value] of Object.entries(entry.attributes)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          metadata[key] = value;
        }
      }
    }

    // Tags
    if (entry.tags?.length) {
      metadata.tags = entry.tags.join(',');
    }

    return metadata;
  }

  /**
   * Format log line for Loki
   */
  private formatLogLine(entry: LogEntry): string {
    // Create a structured log line
    const logObj: Record<string, unknown> = {
      message: entry.message,
      level: entry.level,
      severity_number: entry.severityNumber,
    };

    // Add context
    if (entry.context) logObj.context = entry.context;

    // Add correlation IDs for searchability
    if (entry.correlation?.correlationId) logObj.correlation_id = entry.correlation.correlationId;
    if (entry.trace?.traceId) logObj.trace_id = entry.trace.traceId;

    // Add error details
    if (entry.error) {
      logObj.error = {
        code: entry.error.code,
        name: entry.error.name,
        message: entry.error.stack?.split('\n')[0],
      };
      // Include stack trace for error/fatal
      if (entry.error.stack && (entry.level === 'error' || entry.level === 'fatal')) {
        logObj.stack_trace = entry.error.stack;
      }
    }

    // Add operation timing
    if (entry.operation?.durationMs !== undefined) {
      logObj.duration_ms = entry.operation.durationMs;
    }

    return safeStringify(logObj);
  }

  /**
   * Group entries by labels for efficient batching
   */
  private groupByLabels(entries: LogEntry[]): Map<string, LogEntry[]> {
    const groups = new Map<string, LogEntry[]>();

    for (const entry of entries) {
      const labels = this.buildLabels(entry);
      const key = safeStringify(labels);

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(entry);
    }

    return groups;
  }

  /**
   * Build Loki push request
   */
  private buildPushRequest(entries: LogEntry[]): LokiPushRequest {
    const grouped = this.groupByLabels(entries);
    const streams: LokiStream[] = [];

    for (const [labelKey, groupEntries] of grouped) {
      const labels = JSON.parse(labelKey);
      const values: [string, string, Record<string, unknown>?][] = [];

      for (const entry of groupEntries) {
        // Loki expects nanosecond timestamps as strings
        const timestamp = (entry.timestamp * 1000000).toString();
        const line = this.formatLogLine(entry);
        const metadata = this.buildStructuredMetadata(entry);

        values.push([timestamp, line, metadata]);
      }

      streams.push({ stream: labels, values });
    }

    return { streams };
  }

  /**
   * Flush buffered logs to Loki
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    const entries = [...this.buffer];
    this.buffer = [];

    try {
      const request = this.buildPushRequest(entries);
      await this.sendToLoki(request);
    } catch (error) {
      // Re-add entries to buffer on failure (at the beginning)
      this.buffer = [...entries, ...this.buffer];
      console.error('[LokiTransport] Failed to send logs:', error);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Send logs to Loki API
   */
  private async sendToLoki(request: LokiPushRequest): Promise<void> {
    const url = `${this.config.url}/loki/api/v1/push`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    // Add basic auth if configured
    if (this.config.basicAuth) {
      headers['Authorization'] = `Basic ${btoa(this.config.basicAuth)}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: safeStringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Loki push failed: ${response.status} ${errorText}`);
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    await this.flush();
  }
}
