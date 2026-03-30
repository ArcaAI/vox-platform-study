/**
 * OpenTelemetry transport for sending logs via OTLP
 *
 * This transport sends logs to any OTLP-compatible backend including:
 * - Grafana Cloud (Loki via OTLP)
 * - Grafana Alloy / OpenTelemetry Collector
 * - Tempo (for trace correlation)
 * - Jaeger
 *
 * Benefits over direct Loki transport:
 * - Unified protocol for logs, traces, and metrics
 * - Automatic trace context correlation
 * - Backend-agnostic configuration
 */

import { BaseTransport } from './base.transport';
import type { OTelTransportConfig, LogEntry, LogLevel } from './types';

/**
 * OTLP severity numbers (as per OpenTelemetry spec)
 */
const SEVERITY_NUMBER: Record<LogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
};

/**
 * OTLP severity text
 */
const SEVERITY_TEXT: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  fatal: 'FATAL',
};

/**
 * OpenTelemetry transport implementation
 */
export class OTelTransport extends BaseTransport {
  private readonly endpoint: string;
  private readonly protocol: string;
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly headers: Record<string, string>;
  private readonly injectTraceContext: boolean;
  private readonly resourceAttributes: Record<string, string>;

  private buffer: LogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly batchSize = 100;
  private readonly flushInterval = 5000; // 5 seconds

  constructor(config: OTelTransportConfig) {
    super(config);
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.protocol = config.protocol || 'http/json';
    this.serviceName = config.serviceName;
    this.serviceVersion = config.serviceVersion || '1.0.0';
    this.headers = config.headers || {};
    this.injectTraceContext = config.injectTraceContext ?? true;
    this.resourceAttributes = config.resourceAttributes || {};
  }

  /**
   * Get the logs endpoint URL
   */
  private get logsEndpoint(): string {
    // Handle both full endpoint and base endpoint
    if (this.endpoint.endsWith('/v1/logs')) {
      return this.endpoint;
    }
    return `${this.endpoint}/v1/logs`;
  }

  /**
   * Initialize the transport
   */
  async initialize(): Promise<void> {
    await super.initialize();
    this.startFlushTimer();
  }

  /**
   * Start periodic flush timer
   */
  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flushBuffer().catch((err) => {
        console.error('[OTelTransport] Flush error:', err);
      });
    }, this.flushInterval);
  }

  /**
   * Stop flush timer
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Log entry to buffer
   */
  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    this.buffer.push(entry);

    // Flush if buffer is full
    if (this.buffer.length >= this.batchSize) {
      this.flushBuffer().catch((err) => {
        console.error('[OTelTransport] Flush error:', err);
      });
    }
  }

  /**
   * Flush buffer
   */
  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const entries = this.buffer.splice(0, this.buffer.length);
    await this.sendLogs(entries);
  }

  /**
   * Send logs to OTLP endpoint
   */
  private async sendLogs(entries: LogEntry[]): Promise<void> {
    const payload = this.formatAsOTLP(entries);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };

    try {
      const response = await fetch(this.logsEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        console.error(`[OTelTransport] Failed to send logs: ${response.status} ${response.statusText}`, body);
      }
    } catch (error) {
      console.error('[OTelTransport] Failed to send logs:', error);
    }
  }

  /**
   * Format log entries as OTLP ExportLogsServiceRequest
   */
  private formatAsOTLP(entries: LogEntry[]): object {
    const logRecords = entries.map((entry) => this.formatLogRecord(entry));

    return {
      resourceLogs: [
        {
          resource: {
            attributes: this.buildResourceAttributes(entries[0]),
          },
          scopeLogs: [
            {
              scope: {
                name: '@arcaai/applications/logging',
                version: '1.0.0',
              },
              logRecords,
            },
          ],
        },
      ],
    };
  }

  /**
   * Build resource attributes (low cardinality, shared across all logs)
   */
  private buildResourceAttributes(entry?: LogEntry): Array<{ key: string; value: object }> {
    const attrs: Array<{ key: string; value: object }> = [
      { key: 'service.name', value: { stringValue: this.serviceName } },
      { key: 'service.version', value: { stringValue: this.serviceVersion } },
    ];

    // Add environment
    if (entry?.environment) {
      attrs.push({
        key: 'deployment.environment',
        value: { stringValue: entry.environment },
      });
    }

    // Add hostname
    if (entry?.hostname) {
      attrs.push({
        key: 'host.name',
        value: { stringValue: entry.hostname },
      });
    }

    // Add custom resource attributes
    for (const [key, value] of Object.entries(this.resourceAttributes)) {
      attrs.push({
        key,
        value: { stringValue: value },
      });
    }

    return attrs;
  }

  /**
   * Format a single log entry as OTLP LogRecord
   */
  private formatLogRecord(entry: LogEntry): object {
    const attributes = this.buildLogAttributes(entry);

    const record: Record<string, unknown> = {
      timeUnixNano: String(entry.timestampMs * 1_000_000), // Nanoseconds
      observedTimeUnixNano: String(Date.now() * 1_000_000),
      severityNumber: SEVERITY_NUMBER[entry.level],
      severityText: SEVERITY_TEXT[entry.level],
      body: { stringValue: entry.message },
      attributes,
    };

    // Add trace context if available and enabled
    if (this.injectTraceContext) {
      if (entry.traceId) {
        // OTLP expects trace_id as bytes (base64 or hex)
        record.traceId = this.hexToBytes(entry.traceId);
      }
      if (entry.spanId) {
        record.spanId = this.hexToBytes(entry.spanId);
      }
    }

    return record;
  }

  /**
   * Build log attributes (high cardinality, per-log data)
   */
  private buildLogAttributes(entry: LogEntry): Array<{ key: string; value: object }> {
    const attrs: Array<{ key: string; value: object }> = [];

    // Context
    if (entry.context) {
      attrs.push({ key: 'context', value: { stringValue: entry.context } });
    }

    // Request context
    if (entry.requestId) {
      attrs.push({ key: 'request.id', value: { stringValue: entry.requestId } });
    }

    // User context
    if (entry.userId) {
      attrs.push({ key: 'user.id', value: { stringValue: entry.userId } });
    }
    if (entry.tenantId) {
      attrs.push({ key: 'tenant.id', value: { stringValue: entry.tenantId } });
    }

    // Process info
    if (entry.pid) {
      attrs.push({ key: 'process.pid', value: { intValue: String(entry.pid) } });
    }

    // Error details
    if (entry.error) {
      const errorObj = this.formatError(entry.error);
      if (errorObj) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((errorObj as any).name) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          attrs.push({ key: 'exception.type', value: { stringValue: (errorObj as any).name } });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((errorObj as any).message) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          attrs.push({ key: 'exception.message', value: { stringValue: (errorObj as any).message } });
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((errorObj as any).stack) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          attrs.push({ key: 'exception.stacktrace', value: { stringValue: (errorObj as any).stack } });
        }
      }
    }

    // Add metadata as attributes
    if (entry.meta) {
      for (const [key, value] of Object.entries(entry.meta)) {
        if (value !== undefined && value !== null) {
          attrs.push({
            key: key.replace(/\./g, '_'), // Normalize key
            value: this.formatAttributeValue(value),
          });
        }
      }
    }

    return attrs;
  }

  /**
   * Format attribute value for OTLP
   */
  private formatAttributeValue(value: unknown): object {
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    if (Array.isArray(value)) {
      return {
        arrayValue: {
          values: value.map((v) => this.formatAttributeValue(v)),
        },
      };
    }
    return { stringValue: JSON.stringify(value) };
  }

  /**
   * Convert hex string to base64 bytes (for trace/span IDs)
   */
  private hexToBytes(hex: string): string {
    try {
      // Ensure proper length (32 chars for trace_id, 16 for span_id)
      const paddedHex = hex.padStart(hex.length <= 16 ? 16 : 32, '0');
      const bytes = new Uint8Array(paddedHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || []);
      return Buffer.from(bytes).toString('base64');
    } catch {
      return '';
    }
  }

  /**
   * Flush pending logs
   */
  async flush(): Promise<void> {
    await this.flushBuffer();
  }

  /**
   * Shutdown the transport
   */
  async shutdown(): Promise<void> {
    this.stopFlushTimer();
    await this.flush();
    await super.shutdown();
  }
}

/**
 * Factory function to create an OTEL transport
 */
export function createOTelTransport(config: Omit<OTelTransportConfig, 'name'>): OTelTransport {
  return new OTelTransport({
    ...config,
    name: 'otel' as const,
    enabled: config.enabled ?? true,
  });
}
