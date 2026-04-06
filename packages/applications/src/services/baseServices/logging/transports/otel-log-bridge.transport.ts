import { BaseTransport } from './base.transport';
import type { OTelLogBridgeTransportConfig, LogEntry, LogLevel } from './types';
import { logs, SeverityNumber, type Logger as OTelLogger } from '@opentelemetry/api-logs';

const SEVERITY_MAP: Record<LogLevel, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

export class OTelLogBridgeTransport extends BaseTransport {
  private readonly otelLogger: OTelLogger;

  constructor(config: OTelLogBridgeTransportConfig) {
    super(config);
    this.otelLogger = logs.getLogger(config.serviceName, config.serviceVersion);
  }

  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attributes: Record<string, any> = {};

    if (entry.context) attributes['nestjs.context'] = entry.context;
    if (entry.requestId) attributes['request.id'] = entry.requestId;
    if (entry.tenantId) attributes['tenant.id'] = entry.tenantId;
    if (entry.userId) attributes['user.id'] = entry.userId;
    if (entry.pid) attributes['process.pid'] = entry.pid;

    if (entry.error) {
      const err = this.formatError(entry.error);
      if (err) {
        if (err.name) attributes['exception.type'] = err.name;
        if (err.message) attributes['exception.message'] = err.message;
        if (err.stack) attributes['exception.stacktrace'] = err.stack;
      }
    }

    if (entry.meta) {
      for (const [key, val] of Object.entries(entry.meta)) {
        if (val !== undefined && val !== null) {
          attributes[key] = typeof val === 'object' ? JSON.stringify(val) : val;
        }
      }
    }

    this.otelLogger.emit({
      severityNumber: SEVERITY_MAP[entry.level] ?? SeverityNumber.UNSPECIFIED,
      severityText: entry.level.toUpperCase(),
      body: entry.message,
      attributes,
    });
  }

  async flush(): Promise<void> {
    // LoggerProvider's BatchLogRecordProcessor handles flushing via sdk.shutdown()
  }

  async shutdown(): Promise<void> {
    await super.shutdown();
  }
}

export function createOTelLogBridgeTransport(
  config: Omit<OTelLogBridgeTransportConfig, 'name'>,
): OTelLogBridgeTransport {
  return new OTelLogBridgeTransport({
    ...config,
    name: 'otel-bridge' as const,
    enabled: config.enabled ?? true,
  });
}
