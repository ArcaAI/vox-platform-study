/**
 * Logging Service with pluggable transport support
 *
 * This service provides a unified logging interface that can send logs to
 * multiple destinations (console, file, Highlight.io, Grafana Loki, OpenTelemetry).
 *
 * Features:
 * - Pluggable transport architecture
 * - Structured logging with metadata
 * - OpenTelemetry trace context injection
 * - NestJS LoggerService compatibility
 * - Graceful shutdown support
 */

import * as os from 'os';
import { Injectable, OnModuleInit, OnModuleDestroy, LoggerService } from '@nestjs/common';
import { ILoggingService, LogMeta } from './ILoggingService';
import {
  type ILogTransport,
  type LogEntry,
  type LogLevel,
  type ConsoleTransportConfig,
  type FileTransportConfig,
  type HighlightTransportConfig,
  type LokiTransportConfig,
  type OTelTransportConfig,
  type OTelLogBridgeTransportConfig,
  LOG_LEVEL_VALUES,
  ConsoleTransport,
  FileTransport,
  HighlightTransport,
  LokiTransport,
  OTelTransport,
  OTelLogBridgeTransport,
} from './transports';
import { getEnvBoolean, getEnvString, getEnvNumber, isHumanReadableStdout } from './env.utils';
import { redactEntry } from './redactor';

/**
 * Main logging service implementation
 */
@Injectable()
export class LoggingService implements ILoggingService, LoggerService, OnModuleInit, OnModuleDestroy {
  private transports: ILogTransport[] = [];
  private context?: string;
  private defaultMeta: LogMeta = {};
  private level: LogLevel = 'info';
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly environment: string;
  private readonly hostname: string;
  private readonly pid: number;
  /**
   * Deployment-specific PHI field names, on top of the canonical list in
   * `redactor.ts`. Comma-separated via `LOG_REDACT_FIELDS`.
   */
  private readonly extraRedactFields: string[];

  constructor() {
    this.serviceName = getEnvString('SERVICE_NAME', 'api') || 'api';
    this.serviceVersion = getEnvString('SERVICE_VERSION', '1.0.0') || '1.0.0';
    this.environment = getEnvString('NODE_ENV', 'development') || 'development';
    this.hostname = os.hostname();
    this.pid = process.pid;
    this.level = this.parseLogLevel(getEnvString('LOG_LEVEL', 'info') || 'info');
    this.extraRedactFields = (getEnvString('LOG_REDACT_FIELDS', '') || '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

    this.initializeTransports();
  }

  async onModuleInit(): Promise<void> {
    // Initialize all transports
    await Promise.all(this.transports.map((t) => t.initialize()));
    this.info('LoggingService initialized', 'LoggingService');
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
    // Shutdown all transports
    await Promise.all(this.transports.map((t) => t.shutdown()));
  }

  /**
   * Initialize transports based on environment configuration
   */
  private initializeTransports(): void {
    // Console transport (always enabled)
    const consoleConfig: ConsoleTransportConfig = {
      name: 'console',
      enabled: getEnvBoolean('LOG_CONSOLE_ENABLED', true),
      level: this.level,
      // "Is this development?" is the wrong question; "is a human watching
      // this stream?" is the right one. The dev CLUSTER runs
      // NODE_ENV=development, so the old default shipped ANSI-coloured
      // pretty text to Loki: 4,821 of 4,846 gateway lines came back
      // `detected_level=unknown` on 2026-09-19, and the handful Loki did
      // label were labelled WRONG (it matched the word "error" inside the
      // payload of WARN lines). A container has no TTY; a developer's
      // terminal does. An explicit LOG_CONSOLE_* still wins over both.
      colorize: getEnvBoolean('LOG_CONSOLE_COLORIZE', isHumanReadableStdout()),
      prettyPrint: getEnvBoolean('LOG_CONSOLE_PRETTY', isHumanReadableStdout()),
      json: getEnvBoolean('LOG_CONSOLE_JSON', !isHumanReadableStdout()),
    };
    if (consoleConfig.enabled) {
      this.transports.push(new ConsoleTransport(consoleConfig));
    }

    // File transport
    const fileEnabled = getEnvBoolean('LOG_FILE_ENABLED', false);
    if (fileEnabled) {
      const fileConfig: FileTransportConfig = {
        name: 'file',
        enabled: true,
        level: this.level,
        logDir: getEnvString('LOG_FILE_PATH', './logs') || './logs',
        maxFileSize: getEnvString('LOG_FILE_MAX_SIZE', '10m'),
        maxFiles: getEnvNumber('LOG_FILE_MAX_FILES', 30),
        separateErrorFile: getEnvBoolean('LOG_FILE_SEPARATE_ERROR', true),
      };
      this.transports.push(new FileTransport(fileConfig));
    }

    // Highlight.io transport
    const highlightProjectId = getEnvString('HIGHLIGHT_PROJECT_ID') || getEnvString('AGENTIC_HIGHLIGHT_PROJECT_ID');
    if (highlightProjectId) {
      const highlightConfig: HighlightTransportConfig = {
        name: 'highlight',
        enabled: true,
        level: this.level,
        projectId: highlightProjectId,
        serviceName: this.serviceName,
        serviceVersion: this.serviceVersion,
        backendUrl: getEnvString('HIGHLIGHT_BACKEND_URL'),
        otlpEndpoint: getEnvString('HIGHLIGHT_OTLP_ENDPOINT'),
      };
      this.transports.push(new HighlightTransport(highlightConfig));
    }

    // Loki transport (Grafana)
    const lokiEnabled = getEnvBoolean('LOKI_ENABLED', false);
    const lokiHost = getEnvString('LOKI_HOST');
    if (lokiEnabled && lokiHost) {
      const lokiLabels = this.parseLabels(getEnvString('LOKI_LABELS', ''));
      const lokiConfig: LokiTransportConfig = {
        name: 'loki',
        enabled: true,
        level: this.level,
        host: lokiHost,
        basicAuth: getEnvString('LOKI_BASIC_AUTH'),
        labels: {
          app: this.serviceName,
          env: this.environment,
          ...lokiLabels,
        },
        batchInterval: getEnvNumber('LOKI_BATCH_INTERVAL', 5000),
        batchSize: getEnvNumber('LOKI_BATCH_SIZE', 1000),
        timeout: getEnvNumber('LOKI_TIMEOUT', 30000),
      };
      this.transports.push(new LokiTransport(lokiConfig));
    }

    // OpenTelemetry log transport
    const otelEnabled = getEnvBoolean('OTEL_LOGS_ENABLED', false);
    const useOtelBridge = getEnvBoolean('OTEL_LOG_BRIDGE', false);

    if (otelEnabled && useOtelBridge) {
      const bridgeConfig: OTelLogBridgeTransportConfig = {
        name: 'otel-bridge',
        enabled: true,
        level: this.level,
        serviceName: this.serviceName,
        serviceVersion: this.serviceVersion,
      };
      this.transports.push(new OTelLogBridgeTransport(bridgeConfig));
    } else if (otelEnabled) {
      const otelEndpoint = getEnvString('OTEL_EXPORTER_OTLP_ENDPOINT') || getEnvString('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
      if (otelEndpoint) {
        const otelConfig: OTelTransportConfig = {
          name: 'otel',
          enabled: true,
          level: this.level,
          endpoint: otelEndpoint,
          serviceName: this.serviceName,
          serviceVersion: this.serviceVersion,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          protocol: (getEnvString('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/json') as any) || 'http/json',
          injectTraceContext: getEnvBoolean('OTEL_INJECT_TRACE_CONTEXT', true),
          resourceAttributes: this.parseLabels(getEnvString('OTEL_RESOURCE_ATTRIBUTES', '')),
        };
        this.transports.push(new OTelTransport(otelConfig));
      }
    }
  }

  /**
   * Parse log level string to LogLevel
   */
  private parseLogLevel(level: string): LogLevel {
    const normalized = level.toLowerCase();
    if (normalized === 'verbose') return 'trace';
    if (normalized in LOG_LEVEL_VALUES) return normalized as LogLevel;
    return 'info';
  }

  /**
   * Parse labels string (format: key1=value1,key2=value2)
   */
  private parseLabels(labelsStr: string | undefined): Record<string, string> {
    if (!labelsStr) return {};

    const labels: Record<string, string> = {};
    const pairs = labelsStr.split(',');

    for (const pair of pairs) {
      const [key, value] = pair.split('=').map((s) => s.trim());
      if (key && value) {
        labels[key] = value;
      }
    }

    return labels;
  }

  /**
   * Create a log entry from parameters
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NestJS hands `Logger.log()` whatever the call site passed; narrowing here would refuse the structured objects this function exists to split
  private createLogEntry(level: LogLevel, message: any, meta?: LogMeta | Error | string, context?: string): LogEntry {
    const now = new Date();
    const resolvedContext = typeof meta === 'string' ? meta : context || this.context;
    // A NestJS `Logger.log({ message, ...fields })` call arrives here with the
    // WHOLE object as `message`, and used to be JSON.stringify-ed into the
    // message string — so `traceId`, `requestId`, `sessionId`, `reason` and
    // every other field the gateway logs ended up as JSON inside a string,
    // invisible to `| json` and to the promotion below. Splitting it here
    // covers every level at once, because Nest's `warn`/`error`/`debug` land
    // on the public methods directly rather than on a bridge.
    const { text, fields } = this.splitStructuredMessage(message);
    const resolvedMeta = { ...fields, ...this.resolveMeta(meta) };

    return {
      level,
      levelNumber: LOG_LEVEL_VALUES[level],
      message: text,
      timestamp: now.toISOString(),
      timestampMs: now.getTime(),
      context: resolvedContext,
      traceId: resolvedMeta.traceId || this.defaultMeta.traceId,
      spanId: resolvedMeta.spanId || this.defaultMeta.spanId,
      requestId: resolvedMeta.requestId || this.defaultMeta.requestId,
      userId: resolvedMeta.userId || this.defaultMeta.userId,
      tenantId: resolvedMeta.tenantId || this.defaultMeta.tenantId,
      error: resolvedMeta.error,
      meta: this.extractExtraMeta(resolvedMeta),
      serviceName: this.serviceName,
      serviceVersion: this.serviceVersion,
      environment: this.environment,
      hostname: this.hostname,
      pid: this.pid,
    };
  }

  /**
   * Resolve meta parameter (can be LogMeta, Error, or string)
   */
  private resolveMeta(meta?: LogMeta | Error | string): LogMeta {
    if (!meta) return {};
    if (typeof meta === 'string') return {};
    if (meta instanceof Error) return { error: meta };
    return meta;
  }

  /**
   * Extract extra metadata (excluding known fields)
   */
  private extractExtraMeta(meta: LogMeta): Record<string, unknown> | undefined {
    const knownKeys = ['traceId', 'spanId', 'requestId', 'userId', 'tenantId', 'error'];
    const extra: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(meta)) {
      if (!knownKeys.includes(key) && value !== undefined) {
        extra[key] = value;
      }
    }

    return Object.keys(extra).length > 0 ? extra : undefined;
  }

  /**
   * Split a structured `{ message, ...fields }` payload into its human string
   * and its fields.
   *
   * Only an object carrying a STRING `message` is split — an object without
   * one has no human sentence to promote, so it keeps the previous
   * stringify-it-all behaviour rather than inventing a message.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the input is an unnarrowed NestJS logger argument; the function's whole job is to decide what shape it is
  private splitStructuredMessage(message: any): { text: string; fields: LogMeta } {
    if (
      message !== null &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      !(message instanceof Error) &&
      typeof (message as { message?: unknown }).message === 'string'
    ) {
      const { message: text, ...fields } = message as { message: string } & Record<string, unknown>;
      return { text, fields: fields as LogMeta };
    }

    return { text: this.formatMessage(message), fields: {} };
  }

  /**
   * Format message (stringify objects)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatMessage(message: any): string {
    if (typeof message === 'string') return message;
    if (typeof message === 'object') {
      try {
        return JSON.stringify(message);
      } catch {
        return String(message);
      }
    }
    return String(message);
  }

  /**
   * Dispatch log entry to all transports
   */
  private dispatch(entry: LogEntry): void {
    // PHI redaction happens HERE, once, before any transport
    // sees the entry. Redacting inside each transport would mean every future
    // transport re-implements it and one of them eventually forgets; this is
    // also where the browser SDK applies it, so the two runtimes match.
    //
    // `LOG_REDACT_FIELDS` extends the canonical PHI key list per deployment —
    // it is what finally makes the long-declared `LoggingConfig.redactFields`
    // load-bearing (it had zero readers).
    const safeEntry = redactEntry(entry, this.extraRedactFields);

    for (const transport of this.transports) {
      try {
        transport.log(safeEntry);
      } catch (err) {
        // Fallback to console if transport fails
        console.error(`[LoggingService] Transport ${transport.name} failed:`, err);
      }
    }
  }

  // ========== ILoggingService Implementation ==========

  fatal(message: string, meta?: LogMeta | string, context?: string): void {
    const entry = this.createLogEntry('fatal', message, meta, context);
    this.dispatch(entry);
  }

  error(message: string, meta?: LogMeta | Error | string, context?: string): void {
    const entry = this.createLogEntry('error', message, meta, context);
    this.dispatch(entry);
  }

  warn(message: string, meta?: LogMeta | string, context?: string): void {
    const entry = this.createLogEntry('warn', message, meta, context);
    this.dispatch(entry);
  }

  info(message: string, meta?: LogMeta | string, context?: string): void {
    const entry = this.createLogEntry('info', message, meta, context);
    this.dispatch(entry);
  }

  debug(message: string, meta?: LogMeta | string, context?: string): void {
    const entry = this.createLogEntry('debug', message, meta, context);
    this.dispatch(entry);
  }

  verbose(message: string, meta?: LogMeta | string, context?: string): void {
    const entry = this.createLogEntry('trace', message, meta, context);
    this.dispatch(entry);
  }

  http(message: string, meta?: LogMeta, context?: string): void {
    const entry = this.createLogEntry('info', message, { ...meta, http: true }, context);
    this.dispatch(entry);
  }

  /**
   * Log with explicit level (ILoggingService interface)
   */
  logWithLevel(level: LogLevel, message: string, meta?: LogMeta, context?: string): void {
    const entry = this.createLogEntry(level, message, meta, context);
    this.dispatch(entry);
  }

  setContext(context: string): void {
    this.context = context;
  }

  child(context: string): ILoggingService {
    const childService = new LoggingService();
    childService.context = context;
    childService.defaultMeta = { ...this.defaultMeta };
    // Share transports with parent
    childService.transports = this.transports;
    return childService;
  }

  withMeta(meta: LogMeta): ILoggingService {
    const childService = new LoggingService();
    childService.context = this.context;
    childService.defaultMeta = { ...this.defaultMeta, ...meta };
    // Share transports with parent
    childService.transports = this.transports;
    return childService;
  }

  async flush(): Promise<void> {
    await Promise.all(this.transports.map((t) => t.flush()));
  }

  getLevel(): LogLevel {
    return this.level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  // ========== NestJS LoggerService Implementation ==========

  /**
   * NestJS log method (maps to info)
   */
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- multiple overloads narrowing NestJS's own LoggerService.log signature trip a spurious "duplicate overload" style complaint; @ts-expect-error would itself error if that complaint isn't raised on every TS version
  // @ts-ignore - NestJS LoggerService overload compatibility
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: any, ...optionalParams: any[]): void;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- same overload-compatibility reason as above
  // @ts-ignore
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: any, context?: string): void;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment -- same overload-compatibility reason as above
  // @ts-ignore
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log(message: any, contextOrParams?: string | any[]): void {
    const context = typeof contextOrParams === 'string' ? contextOrParams : undefined;
    // NOT `this.formatMessage(message)`: `createLogEntry` splits a structured
    // payload into its message and its fields, and pre-stringifying here would
    // hand it a string that can no longer be split.
    this.info(message, context);
  }

  /**
   * Set log levels (NestJS interface)
   */
  setLogLevels?(levels: string[]): void {
    // Map NestJS levels to our system
    if (levels.includes('verbose')) this.level = 'trace';
    else if (levels.includes('debug')) this.level = 'debug';
    else if (levels.includes('log')) this.level = 'info';
    else if (levels.includes('warn')) this.level = 'warn';
    else if (levels.includes('error')) this.level = 'error';
  }

  // ========== Utility Methods ==========

  /**
   * Add a custom transport
   */
  addTransport(transport: ILogTransport): void {
    this.transports.push(transport);
  }

  /**
   * Get list of active transport names
   */
  getTransportNames(): string[] {
    return this.transports.map((t) => t.name);
  }

  /**
   * Test logging functionality - outputs test messages at all log levels
   */
  testLogging(): void {
    this.info('=== Running logging test ===', 'LoggingTest');
    this.fatal('Test fatal message', 'LoggingTest');
    this.error('Test error message', new Error('Test error'), 'LoggingTest');
    this.warn('Test warning message', 'LoggingTest');
    this.info('Test info message', 'LoggingTest');
    this.debug('Test debug message', 'LoggingTest');
    this.verbose('Test verbose message', 'LoggingTest');
    this.info('Test with metadata', { userId: 'test-user', requestId: 'test-req' }, 'LoggingTest');
    this.info('=== Logging test completed ===', 'LoggingTest');
  }
}
