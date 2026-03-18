/**
 * Loki transport for sending logs to Grafana Loki
 *
 * This transport sends logs directly to Loki's push API.
 * It supports batching, label customization, and basic authentication.
 *
 * For production use with OpenTelemetry Collector, consider using
 * the OTEL transport instead, which provides better integration with
 * the full Grafana stack (Tempo, Prometheus).
 */

import { BaseTransport } from './base.transport';
import type { LokiTransportConfig, LogEntry, LogLevel } from './types';

/**
 * Loki log stream structure
 */
interface LokiStream {
    stream: Record<string, string>;
    values: Array<[string, string]>; // [timestamp_ns, log_line]
}

/**
 * Loki push payload structure
 */
interface LokiPushPayload {
    streams: LokiStream[];
}

/**
 * Loki transport implementation
 */
export class LokiTransport extends BaseTransport {
    private readonly host: string;
    private readonly basicAuth?: string;
    private readonly headers: Record<string, string>;
    private readonly labels: Record<string, string>;
    private readonly batchInterval: number;
    private readonly batchSize: number;
    private readonly timeout: number;
    private readonly propsToLabels: string[];

    private buffer: LogEntry[] = [];
    private flushTimer: NodeJS.Timeout | null = null;

    constructor(config: LokiTransportConfig) {
        super(config);
        this.host = config.host.replace(/\/$/, ''); // Remove trailing slash
        this.basicAuth = config.basicAuth;
        this.headers = config.headers || {};
        this.labels = config.labels || {};
        this.batchInterval = config.batchInterval || 5000; // 5 seconds
        this.batchSize = config.batchSize || 1000;
        this.timeout = config.timeout || 30000; // 30 seconds
        this.propsToLabels = config.propsToLabels || [];
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
            this.flushBuffer().catch(err => {
                console.error('[LokiTransport] Flush error:', err);
            });
        }, this.batchInterval);
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
            this.flushBuffer().catch(err => {
                console.error('[LokiTransport] Flush error:', err);
            });
        }
    }

    /**
     * Flush buffer to Loki
     */
    private async flushBuffer(): Promise<void> {
        if (this.buffer.length === 0) {
            return;
        }

        const entries = this.buffer.splice(0, this.buffer.length);
        await this.sendLogs(entries);
    }

    /**
     * Send logs to Loki
     */
    private async sendLogs(entries: LogEntry[]): Promise<void> {
        const payload = this.formatPayload(entries);
        const url = `${this.host}/loki/api/v1/push`;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...this.headers,
        };

        // Add basic auth if provided
        if (this.basicAuth) {
            const encoded = Buffer.from(this.basicAuth).toString('base64');
            headers['Authorization'] = `Basic ${encoded}`;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                console.error(
                    `[LokiTransport] Failed to send logs: ${response.status} ${response.statusText}`,
                    body
                );
            }
        } catch (error) {
            if ((error as Error).name === 'AbortError') {
                console.error('[LokiTransport] Request timed out');
            } else {
                console.error('[LokiTransport] Failed to send logs:', error);
            }
        }
    }

    /**
     * Format log entries as Loki push payload
     */
    private formatPayload(entries: LogEntry[]): LokiPushPayload {
        // Group entries by their labels to create separate streams
        const streamMap = new Map<string, LokiStream>();

        for (const entry of entries) {
            const labels = this.buildLabels(entry);
            const labelKey = this.labelsToKey(labels);

            if (!streamMap.has(labelKey)) {
                streamMap.set(labelKey, {
                    stream: labels,
                    values: [],
                });
            }

            const stream = streamMap.get(labelKey)!;
            const timestamp = String(entry.timestampMs * 1_000_000); // Convert to nanoseconds
            const logLine = this.formatLogLine(entry);
            stream.values.push([timestamp, logLine]);
        }

        return {
            streams: Array.from(streamMap.values()),
        };
    }

    /**
     * Build labels for a log entry
     * Labels should be low-cardinality (service, environment, level)
     * High-cardinality data goes in the log line as structured metadata
     */
    private buildLabels(entry: LogEntry): Record<string, string> {
        const labels: Record<string, string> = {
            ...this.labels,
            level: entry.level,
        };

        // Add service name
        if (entry.serviceName) {
            labels.service = this.sanitizeLabel(entry.serviceName);
        }

        // Add environment
        if (entry.environment) {
            labels.env = this.sanitizeLabel(entry.environment);
        }

        // Add context as label (usually class/module name)
        if (entry.context) {
            labels.context = this.sanitizeLabel(entry.context);
        }

        // Add configured props as labels
        for (const prop of this.propsToLabels) {
            const value = (entry as any)[prop] || entry.meta?.[prop];
            if (value !== undefined && value !== null) {
                labels[this.sanitizeLabelName(prop)] = this.sanitizeLabel(String(value));
            }
        }

        return labels;
    }

    /**
     * Convert labels to a unique key for grouping
     */
    private labelsToKey(labels: Record<string, string>): string {
        const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
        return sorted.map(([k, v]) => `${k}=${v}`).join(',');
    }

    /**
     * Sanitize label name (Loki only supports certain characters)
     * Dots are converted to underscores
     */
    private sanitizeLabelName(name: string): string {
        return name.replace(/[^a-zA-Z0-9_]/g, '_');
    }

    /**
     * Sanitize label value
     */
    private sanitizeLabel(value: string): string {
        // Loki labels can contain most characters, but we clean up for safety
        return value.replace(/[\r\n\t]/g, ' ').substring(0, 128);
    }

    /**
     * Format log entry as JSON log line
     * This includes high-cardinality data as structured metadata
     */
    private formatLogLine(entry: LogEntry): string {
        const log: Record<string, unknown> = {
            msg: entry.message,
            ts: entry.timestamp,
        };

        // Add trace context (high cardinality - goes in log line)
        if (entry.traceId) log.trace_id = entry.traceId;
        if (entry.spanId) log.span_id = entry.spanId;
        if (entry.requestId) log.request_id = entry.requestId;

        // Add user context (high cardinality)
        if (entry.userId) log.user_id = entry.userId;
        if (entry.tenantId) log.tenant_id = entry.tenantId;

        // Add host info
        if (entry.hostname) log.hostname = entry.hostname;
        if (entry.pid) log.pid = entry.pid;

        // Add error details
        if (entry.error) {
            log.error = this.formatError(entry.error);
        }

        // Add metadata
        if (entry.meta && Object.keys(entry.meta).length > 0) {
            Object.assign(log, entry.meta);
        }

        return JSON.stringify(log);
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
 * Factory function to create a Loki transport
 */
export function createLokiTransport(
    config: Omit<LokiTransportConfig, 'name'>
): LokiTransport {
    return new LokiTransport({
        ...config,
        name: 'loki' as const,
        enabled: config.enabled ?? true,
    });
}
