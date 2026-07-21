/**
 * @arcaai/vox - OpenTelemetry Transport
 *
 * Transport for OpenTelemetry with support for:
 * - OTLP log export (HTTP JSON/Protobuf)
 * - Trace context propagation
 * - Resource attributes
 * - Span correlation
 *
 * @see https://opentelemetry.io/docs/specs/otel/logs/
 */

import type { ILogTransport, LogEntry, OTelTransportConfig, LogLevel } from '../types';
import { LOG_LEVEL_VALUES } from '../types';
import { safeStringify } from '../utils';

/**
 * OpenTelemetry severity numbers
 * @see https://opentelemetry.io/docs/specs/otel/logs/data-model/#field-severitynumber
 */
const OTEL_SEVERITY: Record<LogLevel, number> = {
  trace: 1, // TRACE
  debug: 5, // DEBUG
  info: 9, // INFO
  warn: 13, // WARN
  error: 17, // ERROR
  fatal: 21, // FATAL
};

const OTEL_SEVERITY_TEXT: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
  fatal: 'FATAL',
};

/**
 * OTLP Log Record
 * @see https://opentelemetry.io/docs/specs/otlp/#otlphttp
 */
interface OTLPLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OTLPAttribute[];
  traceId?: string;
  spanId?: string;
  flags?: number;
}

interface OTLPAttribute {
  key: string;
  value: OTLPValue;
}

interface OTLPValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OTLPValue[] };
  kvlistValue?: { values: OTLPAttribute[] };
}

interface OTLPResourceLogs {
  resource: {
    attributes: OTLPAttribute[];
  };
  scopeLogs: {
    scope: {
      name: string;
      version?: string;
    };
    logRecords: OTLPLogRecord[];
  }[];
}

interface OTLPLogsRequest {
  resourceLogs: OTLPResourceLogs[];
}

/**
 * OpenTelemetry transport implementation.
 *
 * **Gated activation.**
 * Mirrors the `HighlightTransport` defence-in-depth pattern.
 * Shipping consultation telemetry to an OTLP collector is a HIPAA exposure
 * unless the operator has explicitly opted in to a vetted endpoint. This
 * transport therefore refuses to initialise unless ALL of the following are
 * true:
 *
 *   1. `process.env.NODE_ENV !== 'production'` (or `process` is undefined).
 *   2. The caller explicitly opted in via `config.enabled === true`.
 *   3. A non-empty `config.endpoint` (OTLP logs endpoint) is supplied.
 *
 * If any gate fails the transport enters a permanently-disabled state where
 * `initialize()` is a no-op (no flush timer is scheduled, no resource
 * attributes are built) and `log()` is a hard no-op — no in-memory queue,
 * no retries — so a misconfigured production deploy cannot silently buffer
 * PHI in memory that a later runtime gate-flip could ship to the collector.
 *
 * `SDKLogger.dispatch()` already pre-redacts every entry via `redactPHI` so
 * the primary in-process PHI safety boundary is upstream of this transport;
 * this activation gate is the second, fail-closed layer.
 */
export class OTelTransport implements ILogTransport {
  readonly name = 'otel';
  private config: OTelTransportConfig;
  private level: LogLevel;
  private buffer: LogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  private resourceAttributes: OTLPAttribute[] = [];
  /**
   * Once true, this transport will never POST another log and will not even
   * queue them. Set when the activation gate refuses activation (production env,
   * not opted in, or missing endpoint).
   */
  private permanentlyDisabled = false;

  constructor(config: OTelTransportConfig) {
    this.config = {
      protocol: 'http/json',
      propagateTraceContext: true,
      samplingRatio: 1.0,
      ...config,
    };
    // `config.level` is a pre-existing untyped extension carried over from the
    // SDK's original transport contract. Keeping the runtime behaviour intact.
    this.level = (config as OTelTransportConfig & { level?: LogLevel }).level || 'info';
    if (!OTelTransport.isAllowedToActivate(config)) {
      this.permanentlyDisabled = true;
      this.buffer = [];
    }
  }

  /**
   * Activation predicate.
   *
   * Pure & static so `SDKLogger.initializeTransports()` can also call it
   * to skip constructing the transport entirely.
   */
  static isAllowedToActivate(config: OTelTransportConfig): boolean {
    if (!config.enabled) return false;
    if (!config.endpoint || config.endpoint.trim().length === 0) return false;
    // `process` may be undefined in some browser bundles — treat as non-prod.
    const env = typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined;
    if (env === 'production') return false;
    return true;
  }

  async initialize(): Promise<void> {
    if (this.permanentlyDisabled) return;

    // Build resource attributes once
    this.resourceAttributes = this.buildResourceAttributes();

    // Start batch flush timer (every 5 seconds)
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[OTelTransport] Flush error:', err);
      });
    }, 5000);
  }

  /**
   * Build OpenTelemetry resource attributes
   */
  private buildResourceAttributes(): OTLPAttribute[] {
    const attrs: OTLPAttribute[] = [
      { key: 'service.name', value: { stringValue: this.config.resourceAttributes?.['service.name'] || 'agentic-sdk' } },
      { key: 'telemetry.sdk.name', value: { stringValue: '@arcaai/vox' } },
      { key: 'telemetry.sdk.language', value: { stringValue: 'javascript' } },
    ];

    // Add configured resource attributes
    if (this.config.resourceAttributes) {
      for (const [key, value] of Object.entries(this.config.resourceAttributes)) {
        if (key !== 'service.name') {
          attrs.push({ key, value: { stringValue: value } });
        }
      }
    }

    return attrs;
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
   * When the transport is permanently disabled (production env,
   * not opted in, or missing endpoint) this is a hard no-op — we do not even
   * queue the entry, so a misconfigured deploy cannot silently buffer PHI in
   * memory that a later runtime gate-flip could flush to the OTLP collector.
   */
  log(entry: LogEntry): void {
    if (this.permanentlyDisabled) return;
    if (!this.shouldLog(entry.level)) return;

    // Apply sampling
    if (this.config.samplingRatio && this.config.samplingRatio < 1) {
      if (Math.random() > this.config.samplingRatio) {
        return;
      }
    }

    this.buffer.push(entry);

    // Flush if buffer is large
    if (this.buffer.length >= 100) {
      this.flush().catch((err) => {
        console.error('[OTelTransport] Flush error:', err);
      });
    }
  }

  /**
   * Convert value to OTLP value format
   */
  private toOTLPValue(value: unknown): OTLPValue {
    if (typeof value === 'string') {
      return { stringValue: value };
    }
    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return { intValue: value.toString() };
      }
      return { doubleValue: value };
    }
    if (typeof value === 'boolean') {
      return { boolValue: value };
    }
    if (Array.isArray(value)) {
      return { arrayValue: { values: value.map((v) => this.toOTLPValue(v)) } };
    }
    if (typeof value === 'object' && value !== null) {
      const kvlist: OTLPAttribute[] = [];
      for (const [k, v] of Object.entries(value)) {
        kvlist.push({ key: k, value: this.toOTLPValue(v) });
      }
      return { kvlistValue: { values: kvlist } };
    }
    return { stringValue: String(value) };
  }

  /**
   * Build OTLP attributes from log entry
   */
  private buildAttributes(entry: LogEntry): OTLPAttribute[] {
    const attrs: OTLPAttribute[] = [];

    // Context
    if (entry.context) {
      attrs.push({ key: 'log.context', value: { stringValue: entry.context } });
    }

    // Correlation context
    if (entry.correlation?.correlationId) {
      attrs.push({ key: 'correlation.id', value: { stringValue: entry.correlation.correlationId } });
    }
    if (entry.correlation?.requestId) {
      attrs.push({ key: 'http.request_id', value: { stringValue: entry.correlation.requestId } });
    }
    if (entry.correlation?.sessionId) {
      attrs.push({ key: 'session.id', value: { stringValue: entry.correlation.sessionId } });
    }

    // User context
    if (entry.user?.userId) {
      attrs.push({ key: 'user.id', value: { stringValue: entry.user.userId } });
    }
    if (entry.user?.tenantId) {
      attrs.push({ key: 'tenant.id', value: { stringValue: entry.user.tenantId } });
    }
    if (entry.user?.doctorId) {
      attrs.push({ key: 'user.doctor_id', value: { stringValue: entry.user.doctorId } });
    }
    if (entry.user?.patientId) {
      attrs.push({ key: 'user.patient_id', value: { stringValue: entry.user.patientId } });
    }

    // Operation context
    if (entry.operation?.operation) {
      attrs.push({ key: 'operation.name', value: { stringValue: entry.operation.operation } });
    }
    if (entry.operation?.component) {
      attrs.push({ key: 'code.namespace', value: { stringValue: entry.operation.component } });
    }
    if (entry.operation?.durationMs !== undefined) {
      attrs.push({ key: 'operation.duration_ms', value: { doubleValue: entry.operation.durationMs } });
    }
    if (entry.operation?.success !== undefined) {
      attrs.push({ key: 'operation.success', value: { boolValue: entry.operation.success } });
    }

    // HTTP context (using OpenTelemetry semantic conventions)
    if (entry.http) {
      if (entry.http.method) {
        attrs.push({ key: 'http.method', value: { stringValue: entry.http.method } });
      }
      if (entry.http.url) {
        attrs.push({ key: 'http.url', value: { stringValue: entry.http.url } });
      }
      if (entry.http.statusCode) {
        attrs.push({ key: 'http.status_code', value: { intValue: entry.http.statusCode.toString() } });
      }
      if (entry.http.responseTimeMs !== undefined) {
        attrs.push({ key: 'http.response_time_ms', value: { doubleValue: entry.http.responseTimeMs } });
      }
      if (entry.http.userAgent) {
        attrs.push({ key: 'http.user_agent', value: { stringValue: entry.http.userAgent } });
      }
    }

    // Error context (using OpenTelemetry semantic conventions)
    if (entry.error) {
      if (entry.error.name) {
        attrs.push({ key: 'exception.type', value: { stringValue: entry.error.name } });
      }
      if (entry.error.code) {
        attrs.push({ key: 'error.code', value: { stringValue: entry.error.code } });
      }
      if (entry.error.stack) {
        attrs.push({ key: 'exception.stacktrace', value: { stringValue: entry.error.stack } });
      }
    }

    // SDK context
    if (entry.sdk?.consultationId) {
      attrs.push({ key: 'arcaai.consultation_id', value: { stringValue: entry.sdk.consultationId } });
    }
    if (entry.sdk?.modelId) {
      attrs.push({ key: 'arcaai.model_id', value: { stringValue: entry.sdk.modelId } });
    }

    // Additional attributes
    if (entry.attributes) {
      for (const [key, value] of Object.entries(entry.attributes)) {
        attrs.push({ key, value: this.toOTLPValue(value) });
      }
    }

    // Tags
    if (entry.tags?.length) {
      attrs.push({ key: 'tags', value: { arrayValue: { values: entry.tags.map((t) => ({ stringValue: t })) } } });
    }

    return attrs;
  }

  /**
   * Convert log entry to OTLP log record
   */
  private toOTLPLogRecord(entry: LogEntry): OTLPLogRecord {
    // Convert timestamp to nanoseconds
    const timeUnixNano = (entry.timestamp * 1000000).toString();

    const record: OTLPLogRecord = {
      timeUnixNano,
      observedTimeUnixNano: timeUnixNano,
      severityNumber: OTEL_SEVERITY[entry.level],
      severityText: OTEL_SEVERITY_TEXT[entry.level],
      body: { stringValue: entry.message },
      attributes: this.buildAttributes(entry),
    };

    // Add trace context for correlation with traces
    if (this.config.propagateTraceContext) {
      if (entry.trace?.traceId) {
        // Convert UUID format to OTEL format (remove dashes, ensure 32 chars)
        record.traceId = this.normalizeTraceId(entry.trace.traceId);
      }
      if (entry.trace?.spanId) {
        // Ensure 16 chars for span ID
        record.spanId = this.normalizeSpanId(entry.trace.spanId);
      }
      if (entry.trace?.traceFlags !== undefined) {
        record.flags = entry.trace.traceFlags;
      }
    }

    return record;
  }

  /**
   * Normalize trace ID to 32 hex characters
   */
  private normalizeTraceId(traceId: string): string {
    const cleaned = traceId.replace(/-/g, '');
    if (cleaned.length === 32) return cleaned;
    if (cleaned.length < 32) return cleaned.padStart(32, '0');
    return cleaned.slice(0, 32);
  }

  /**
   * Normalize span ID to 16 hex characters
   */
  private normalizeSpanId(spanId: string): string {
    const cleaned = spanId.replace(/-/g, '');
    if (cleaned.length === 16) return cleaned;
    if (cleaned.length < 16) return cleaned.padStart(16, '0');
    return cleaned.slice(0, 16);
  }

  /**
   * Build OTLP logs request
   */
  private buildLogsRequest(entries: LogEntry[]): OTLPLogsRequest {
    const logRecords = entries.map((entry) => this.toOTLPLogRecord(entry));

    return {
      resourceLogs: [
        {
          resource: {
            attributes: this.resourceAttributes,
          },
          scopeLogs: [
            {
              scope: {
                name: '@arcaai/vox',
                version: '2.0.0',
              },
              logRecords,
            },
          ],
        },
      ],
    };
  }

  /**
   * Flush buffered logs
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.buffer.length === 0) {
      return;
    }

    this.isFlushing = true;
    const entries = [...this.buffer];
    this.buffer = [];

    try {
      const request = this.buildLogsRequest(entries);
      await this.sendToOTLP(request);
    } catch (error) {
      // Re-add entries to buffer on failure
      this.buffer = [...entries, ...this.buffer];
      console.error('[OTelTransport] Failed to send logs:', error);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Send logs to OTLP endpoint
   */
  private async sendToOTLP(request: OTLPLogsRequest): Promise<void> {
    // Determine endpoint
    let url = this.config.endpoint;
    if (!url.endsWith('/v1/logs')) {
      url = url.replace(/\/$/, '') + '/v1/logs';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.headers,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: safeStringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`OTLP push failed: ${response.status} ${errorText}`);
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
