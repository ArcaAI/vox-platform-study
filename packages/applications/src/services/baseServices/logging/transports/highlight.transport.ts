/**
 * Highlight.io transport for sending logs to Highlight
 *
 * This transport sends logs to Highlight.io via their HTTP API.
 * For production use, consider using @highlight-run/pino transport
 * which provides better batching and retry logic.
 */

import { BaseTransport } from './base.transport';
import type { HighlightTransportConfig, LogEntry, LogLevel } from './types';

/**
 * Map our log levels to Highlight severity levels
 */
const LEVEL_TO_SEVERITY: Record<LogLevel, string> = {
    trace: 'TRACE',
    debug: 'DEBUG',
    info: 'INFO',
    warn: 'WARN',
    error: 'ERROR',
    fatal: 'FATAL',
};

/**
 * Highlight.io transport implementation
 *
 * Uses native HTTP to send logs to Highlight's OTLP endpoint.
 * For better performance in production, use @highlight-run/pino as a Pino transport.
 */
export class HighlightTransport extends BaseTransport {
    private readonly projectId: string;
    private readonly serviceName: string;
    private readonly serviceVersion: string;
    private readonly backendUrl: string;
    private readonly otlpEndpoint: string;

    private buffer: LogEntry[] = [];
    private flushTimer: NodeJS.Timeout | null = null;
    private readonly batchSize = 100;
    private readonly flushInterval = 5000; // 5 seconds

    constructor(config: HighlightTransportConfig) {
        super(config);
        this.projectId = config.projectId;
        this.serviceName = config.serviceName || 'api';
        this.serviceVersion = config.serviceVersion || '1.0.0';
        this.backendUrl = config.backendUrl || 'https://otel.highlight.io:4318';
        this.otlpEndpoint = config.otlpEndpoint || `${this.backendUrl}/v1/logs`;
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
                console.error('[HighlightTransport] Flush error:', err);
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
            this.flushBuffer().catch(err => {
                console.error('[HighlightTransport] Flush error:', err);
            });
        }
    }

    /**
     * Flush buffer to Highlight
     */
    private async flushBuffer(): Promise<void> {
        if (this.buffer.length === 0) {
            return;
        }

        const entries = this.buffer.splice(0, this.buffer.length);
        await this.sendLogs(entries);
    }

    /**
     * Send logs to Highlight's OTLP endpoint
     */
    private async sendLogs(entries: LogEntry[]): Promise<void> {
        const resourceLogs = this.formatAsOTLP(entries);

        try {
            const response = await fetch(this.otlpEndpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-highlight-project': this.projectId,
                },
                body: JSON.stringify({ resourceLogs }),
            });

            if (!response.ok) {
                console.error(
                    `[HighlightTransport] Failed to send logs: ${response.status} ${response.statusText}`
                );
            }
        } catch (error) {
            console.error('[HighlightTransport] Failed to send logs:', error);
        }
    }

    /**
     * Format log entries as OTLP log records
     */
    private formatAsOTLP(entries: LogEntry[]): object[] {
        const logRecords = entries.map(entry => this.formatLogRecord(entry));

        return [
            {
                resource: {
                    attributes: [
                        { key: 'service.name', value: { stringValue: this.serviceName } },
                        { key: 'service.version', value: { stringValue: this.serviceVersion } },
                        { key: 'highlight.project_id', value: { stringValue: this.projectId } },
                        ...(entries[0]?.environment
                            ? [{ key: 'deployment.environment', value: { stringValue: entries[0].environment } }]
                            : []),
                    ],
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
        ];
    }

    /**
     * Format a single log entry as OTLP log record
     */
    private formatLogRecord(entry: LogEntry): object {
        const attributes: Array<{ key: string; value: object }> = [];

        // Add context
        if (entry.context) {
            attributes.push({ key: 'context', value: { stringValue: entry.context } });
        }

        // Add trace context
        if (entry.traceId) {
            attributes.push({ key: 'trace_id', value: { stringValue: entry.traceId } });
        }
        if (entry.spanId) {
            attributes.push({ key: 'span_id', value: { stringValue: entry.spanId } });
        }

        // Add request context
        if (entry.requestId) {
            attributes.push({ key: 'request_id', value: { stringValue: entry.requestId } });
        }
        if (entry.userId) {
            attributes.push({ key: 'user_id', value: { stringValue: entry.userId } });
        }
        if (entry.tenantId) {
            attributes.push({ key: 'tenant_id', value: { stringValue: entry.tenantId } });
        }

        // Add error details
        if (entry.error) {
            const errorObj = this.formatError(entry.error);
            if (errorObj) {
                attributes.push({
                    key: 'error',
                    value: { stringValue: JSON.stringify(errorObj) },
                });
            }
        }

        // Add metadata
        if (entry.meta) {
            for (const [key, value] of Object.entries(entry.meta)) {
                if (value !== undefined && value !== null) {
                    attributes.push({
                        key,
                        value: this.formatAttributeValue(value),
                    });
                }
            }
        }

        return {
            timeUnixNano: String(entry.timestampMs * 1_000_000), // Convert to nanoseconds
            severityNumber: this.getSeverityNumber(entry.level),
            severityText: LEVEL_TO_SEVERITY[entry.level],
            body: { stringValue: entry.message },
            attributes,
            ...(entry.traceId && { traceId: this.hexToBase64(entry.traceId) }),
            ...(entry.spanId && { spanId: this.hexToBase64(entry.spanId) }),
        };
    }

    /**
     * Get OTLP severity number from log level
     */
    private getSeverityNumber(level: LogLevel): number {
        const severityMap: Record<LogLevel, number> = {
            trace: 1,
            debug: 5,
            info: 9,
            warn: 13,
            error: 17,
            fatal: 21,
        };
        return severityMap[level];
    }

    /**
     * Format attribute value for OTLP
     */
    private formatAttributeValue(value: unknown): object {
        if (typeof value === 'string') {
            return { stringValue: value };
        }
        if (typeof value === 'number') {
            return Number.isInteger(value)
                ? { intValue: String(value) }
                : { doubleValue: value };
        }
        if (typeof value === 'boolean') {
            return { boolValue: value };
        }
        return { stringValue: JSON.stringify(value) };
    }

    /**
     * Convert hex string to base64 (for trace/span IDs)
     */
    private hexToBase64(hex: string): string {
        try {
            const bytes = new Uint8Array(
                hex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
            );
            return Buffer.from(bytes).toString('base64');
        } catch {
            return hex;
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
 * Factory function to create a Highlight transport
 */
export function createHighlightTransport(
    config: Omit<HighlightTransportConfig, 'name'>
): HighlightTransport {
    return new HighlightTransport({
        ...config,
        name: 'highlight' as const,
        enabled: config.enabled ?? true,
    });
}
