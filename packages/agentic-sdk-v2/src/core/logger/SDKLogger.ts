/**
 * @arcaai/vox - SDK Logger Implementation
 *
 * A comprehensive logging implementation for browser/client-side SDK with support for:
 * - Highlight.io integration
 * - Grafana Loki integration
 * - OpenTelemetry trace context propagation
 * - Correlation ID tracking across operations
 *
 * Features:
 * - Structured logging with rich metadata
 * - Automatic trace context injection
 * - Child loggers with inherited context
 * - Operation timing utilities
 * - Graceful shutdown with log flushing
 */

import type {
  ISDKLogger,
  LoggerConfig,
  LogLevel,
  LogMeta,
  LogEntry,
  TraceContext,
  CorrelationContext,
  UserContext,
  OperationContext,
  ErrorContext,
  OperationTimer,
  ResourceInfo,
  ILogTransport,
} from './types';
import { LOG_LEVEL_VALUES } from './types';
import { ConsoleTransport } from './transports/console.transport';
import { HighlightTransport } from './transports/highlight.transport';
import { ClarityTransport } from './transports/clarity.transport';
import { LokiTransport } from './transports/loki.transport';
import { OTelTransport } from './transports/otel.transport';
import { generateId } from './utils';
import { redactPHI } from './redactor';

// SDK Version (should match package.json)
const SDK_VERSION = '3.0.0';
const SDK_NAME = '@arcaai/vox';

const DEFAULT_PHI_REDACT_FIELDS = [
  'patientId',
  'doctorId',
  'consultationId',
  'patientName',
  'doctorName',
  'ssn',
  'dateOfBirth',
  'mrn',
  'token',
  'accessToken',
  'refreshToken',
  'password',
  'apiKey',
];

/**
 * Default logger configuration
 */
const DEFAULT_CONFIG: LoggerConfig = {
  level: 'info',
  debug: false,
  serviceName: 'agentic-sdk',
  environment: typeof process !== 'undefined' ? process.env?.NODE_ENV || 'development' : 'development',
  console: {
    enabled: true,
    colorize: true,
    prettyPrint: true,
    includeTimestamp: true,
  },
  autoCorrelationId: true,
  maxMessageLength: 10000,
};

/**
 * SDK Logger Implementation
 */
export class SDKLogger implements ISDKLogger {
  private config: LoggerConfig;
  private transports: ILogTransport[] = [];
  private context?: string;
  private defaultMeta: LogMeta = {};
  private correlationId?: string;
  private resourceInfo: ResourceInfo;
  private initialized = false;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.resourceInfo = this.buildResourceInfo();

    // Auto-generate correlation ID if enabled
    if (this.config.autoCorrelationId) {
      this.correlationId = this.generateCorrelationId();
    }

    // Initialize transports
    this.initializeTransports();
  }

  /**
   * Build resource information for log entries
   */
  private buildResourceInfo(): ResourceInfo {
    const platform = this.detectPlatform();
    const deviceType = this.detectDeviceType();

    return {
      serviceName: this.config.serviceName || 'agentic-sdk',
      serviceVersion: this.config.serviceVersion,
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
      environment: this.config.environment,
      platform,
      deviceType,
    };
  }

  /**
   * Detect platform information
   */
  private detectPlatform(): string {
    if (typeof window !== 'undefined' && typeof navigator !== 'undefined') {
      return navigator.userAgent;
    }
    if (typeof process !== 'undefined') {
      return `Node.js ${process.version}`;
    }
    return 'unknown';
  }

  /**
   * Detect device type
   */
  private detectDeviceType(): 'web' | 'mobile' | 'desktop' {
    if (typeof window === 'undefined') {
      return 'desktop'; // Node.js environment
    }

    const ua = navigator.userAgent.toLowerCase();
    if (/mobile|android|iphone|ipad|tablet/i.test(ua)) {
      return 'mobile';
    }
    return 'web';
  }

  /**
   * Initialize all configured transports
   */
  private initializeTransports(): void {
    // Console transport
    if (this.config.console?.enabled !== false) {
      this.transports.push(
        new ConsoleTransport({
          enabled: true,
          level: this.config.console?.level || this.config.level,
          colorize: this.config.console?.colorize ?? this.config.debug,
          prettyPrint: this.config.console?.prettyPrint ?? this.config.debug,
          includeTimestamp: this.config.console?.includeTimestamp ?? true,
        }),
      );
    }

    // Highlight.io transport.
    //
    // Only construct the transport when the activation gate
    // permits it (not production, explicit opt-in, DSN present). In production
    // or without opt-in we do not even push it onto the transport list, so no
    // PHI-bearing log entry can ever reach this transport. The constructor
    // re-checks the gate as a belt-and-suspenders safety.
    if (this.config.highlight && HighlightTransport.isAllowedToActivate(this.config.highlight)) {
      this.transports.push(
        new HighlightTransport({
          ...this.config.highlight,
          serviceName: this.config.highlight.serviceName || this.config.serviceName,
          environment: this.config.highlight.environment || this.config.environment,
        }),
      );
    }

    // Microsoft Clarity transport.
    //
    // Same fail-closed treatment as Highlight above, and for a stronger
    // reason: Clarity is a session-replay product recording the DOM, and
    // Microsoft does not offer a HIPAA BAA for it. Only construct the
    // transport when the activation gate permits (not production, explicit
    // opt-in, project ID present) so no PHI-bearing entry can ever reach it.
    if (this.config.clarity && ClarityTransport.isAllowedToActivate(this.config.clarity)) {
      this.transports.push(
        new ClarityTransport({
          ...this.config.clarity,
          serviceName: this.config.clarity.serviceName || this.config.serviceName,
          environment: this.config.clarity.environment || this.config.environment,
        }),
      );
    }

    // Loki transport (Grafana)
    if (this.config.loki?.enabled && this.config.loki.url) {
      this.transports.push(
        new LokiTransport({
          ...this.config.loki,
          labels: {
            app: this.config.serviceName || 'agentic-sdk',
            env: this.config.environment || 'development',
            ...this.config.loki.labels,
          },
        }),
      );
    }

    // OpenTelemetry transport
    if (this.config.otel?.enabled && this.config.otel.endpoint) {
      this.transports.push(
        new OTelTransport({
          ...this.config.otel,
          resourceAttributes: {
            'service.name': this.config.serviceName || 'agentic-sdk',
            'service.version': this.config.serviceVersion || SDK_VERSION,
            'deployment.environment': this.config.environment || 'development',
            ...this.config.otel.resourceAttributes,
          },
        }),
      );
    }

    // Custom transports
    if (this.config.customTransports) {
      this.transports.push(...this.config.customTransports);
    }
  }

  /**
   * Initialize all transports (async)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await Promise.all(this.transports.map((t) => t.initialize()));
    this.initialized = true;

    this.debug('SDKLogger initialized', {
      operation: 'initialize',
      component: 'SDKLogger',
      attributes: {
        transports: this.transports.map((t) => t.name),
        level: this.config.level,
        correlationId: this.correlationId,
      },
    });
  }

  /**
   * Check if a level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.config.level];
  }

  /**
   * Create a log entry
   */
  private createLogEntry(level: LogLevel, message: string, meta?: LogMeta | Error): LogEntry {
    const now = Date.now();
    const resolvedMeta = this.resolveMeta(meta);

    // Truncate message if needed
    const truncatedMessage = this.config.maxMessageLength ? message.slice(0, this.config.maxMessageLength) : message;

    // Build trace context
    const trace: TraceContext | undefined = resolvedMeta.traceId
      ? {
          traceId: resolvedMeta.traceId,
          spanId: resolvedMeta.spanId,
          parentSpanId: resolvedMeta.parentSpanId,
          traceFlags: resolvedMeta.traceFlags,
        }
      : undefined;

    // Build correlation context
    const correlation: CorrelationContext = {
      correlationId: resolvedMeta.correlationId || this.correlationId,
      requestId: resolvedMeta.requestId,
      sessionId: resolvedMeta.sessionId,
      ...trace,
    };

    // Build user context
    const user: UserContext | undefined =
      resolvedMeta.userId || resolvedMeta.tenantId || resolvedMeta.doctorId || resolvedMeta.patientId
        ? {
            userId: resolvedMeta.userId,
            tenantId: resolvedMeta.tenantId,
            doctorId: resolvedMeta.doctorId,
            patientId: resolvedMeta.patientId,
          }
        : undefined;

    // Build operation context
    const operation: OperationContext | undefined = resolvedMeta.operation
      ? {
          operation: resolvedMeta.operation,
          component: resolvedMeta.component,
          module: resolvedMeta.module,
          durationMs: resolvedMeta.durationMs,
          success: resolvedMeta.success,
        }
      : undefined;

    // Build error context
    const error = this.buildErrorContext(resolvedMeta.error);

    return {
      timestamp: now,
      timestampIso: new Date(now).toISOString(),
      level,
      severityNumber: LOG_LEVEL_VALUES[level],
      message: truncatedMessage,
      context: this.context,
      trace,
      correlation,
      user,
      operation,
      error,
      http: resolvedMeta.http,
      sdk: resolvedMeta.sdk,
      attributes: this.redactSensitiveFields(resolvedMeta.attributes),
      tags: resolvedMeta.tags,
      resource: this.resourceInfo,
    };
  }

  /**
   * Resolve meta parameter (can be LogMeta or Error)
   */
  private resolveMeta(meta?: LogMeta | Error): LogMeta {
    if (!meta) return { ...this.defaultMeta };
    if (meta instanceof Error) {
      return { ...this.defaultMeta, error: meta };
    }
    return { ...this.defaultMeta, ...meta };
  }

  /**
   * Build error context from Error or ErrorContext
   */
  private buildErrorContext(error?: ErrorContext | Error): ErrorContext | undefined {
    if (!error) return undefined;

    if (error instanceof Error) {
      return {
        name: error.name,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node/system errors may carry code.
        code: (error as any).code,
        stack: error.stack,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Error.cause typing varies by runtime.
        cause: (error as any).cause,
      };
    }

    return error;
  }

  /**
   * Redact sensitive fields from attributes
   */
  private redactSensitiveFields(attributes?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!attributes) {
      return attributes;
    }

    const fieldsToRedact = new Set([...DEFAULT_PHI_REDACT_FIELDS, ...(this.config.redactFields ?? [])]);

    const redacted = { ...attributes };
    for (const field of fieldsToRedact) {
      if (field in redacted) {
        redacted[field] = '[REDACTED]';
      }
    }
    return redacted;
  }

  /**
   * Dispatch log entry to all transports.
   *
   * Every entry is run through `redactPHI` BEFORE any transport
   * (highlight, loki, otel, console, custom) sees it. The redactor walks the
   * full entry — `user`, `sdk`, `attributes`, error stacks, etc. — and replaces
   * PHI fields with `[REDACTED]` and `data:`/`blob:`/`file:` URLs with
   * `[REDACTED-URL]`. This is the primary in-process PHI safety boundary.
   *
   * The redactor returns a deep clone, so transports may safely mutate their
   * input without affecting downstream transports.
   */
  private dispatch(entry: LogEntry): void {
    const safeEntry = redactPHI(entry, this.config.redactFields) as LogEntry;
    for (const transport of this.transports) {
      try {
        transport.log(safeEntry);
      } catch (err) {
        console.error(`[SDKLogger] Transport ${transport.name} failed:`, err);
      }
    }
  }

  // ==========================================================================
  // ISDKLogger Implementation
  // ==========================================================================

  fatal(message: string, meta?: LogMeta): void {
    if (!this.shouldLog('fatal')) return;
    const entry = this.createLogEntry('fatal', message, meta);
    this.dispatch(entry);
  }

  error(message: string, meta?: LogMeta | Error): void {
    if (!this.shouldLog('error')) return;
    const entry = this.createLogEntry('error', message, meta);
    this.dispatch(entry);
  }

  warn(message: string, meta?: LogMeta): void {
    if (!this.shouldLog('warn')) return;
    const entry = this.createLogEntry('warn', message, meta);
    this.dispatch(entry);
  }

  info(message: string, meta?: LogMeta): void {
    if (!this.shouldLog('info')) return;
    const entry = this.createLogEntry('info', message, meta);
    this.dispatch(entry);
  }

  debug(message: string, meta?: LogMeta): void {
    if (!this.shouldLog('debug')) return;
    const entry = this.createLogEntry('debug', message, meta);
    this.dispatch(entry);
  }

  trace(message: string, meta?: LogMeta): void {
    if (!this.shouldLog('trace')) return;
    const entry = this.createLogEntry('trace', message, meta);
    this.dispatch(entry);
  }

  /**
   * Create a child logger with a specific context
   */
  child(context: string): ISDKLogger {
    const child = new SDKLogger(this.config);
    child.context = context;
    child.defaultMeta = { ...this.defaultMeta };
    child.correlationId = this.correlationId;
    child.transports = this.transports; // Share transports
    child.initialized = this.initialized;
    return child;
  }

  /**
   * Create a logger with additional default metadata
   */
  withMeta(meta: LogMeta): ISDKLogger {
    const child = new SDKLogger(this.config);
    child.context = this.context;
    child.defaultMeta = { ...this.defaultMeta, ...meta };
    child.correlationId = this.correlationId;
    child.transports = this.transports;
    child.initialized = this.initialized;
    return child;
  }

  /**
   * Create a logger with correlation context
   */
  withCorrelation(correlation: CorrelationContext): ISDKLogger {
    return this.withMeta({
      correlationId: correlation.correlationId,
      requestId: correlation.requestId,
      sessionId: correlation.sessionId,
      traceId: correlation.traceId,
      spanId: correlation.spanId,
    });
  }

  /**
   * Create a logger with user context
   */
  withUser(user: UserContext): ISDKLogger {
    return this.withMeta({
      userId: user.userId,
      tenantId: user.tenantId,
      doctorId: user.doctorId,
      patientId: user.patientId,
    });
  }

  /**
   * Set global correlation ID
   */
  setCorrelationId(correlationId: string): void {
    this.correlationId = correlationId;
  }

  /**
   * Get current correlation ID
   */
  getCorrelationId(): string | undefined {
    return this.correlationId;
  }

  /**
   * Generate a new correlation ID
   */
  generateCorrelationId(): string {
    return generateId();
  }

  /**
   * Start a timed operation
   */
  startOperation(name: string, meta?: LogMeta): OperationTimer {
    const startTime = performance.now();
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Captured for timer end() closure.
    const logger = this;

    this.debug(`Operation started: ${name}`, {
      ...meta,
      operation: name,
      component: meta?.component || this.context,
    });

    return {
      name,
      startTime,
      end(success = true, endMeta?: LogMeta): void {
        const durationMs = Math.round(performance.now() - startTime);
        const level = success ? 'info' : 'warn';

        logger[level](`Operation completed: ${name}`, {
          ...meta,
          ...endMeta,
          operation: name,
          component: meta?.component || logger.context,
          durationMs,
          success,
        });
      },
      error(error: Error | string, errorMeta?: LogMeta): void {
        const durationMs = Math.round(performance.now() - startTime);
        const errorObj = typeof error === 'string' ? new Error(error) : error;

        logger.error(`Operation failed: ${name}`, {
          ...meta,
          ...errorMeta,
          operation: name,
          component: meta?.component || logger.context,
          durationMs,
          success: false,
          error: errorObj,
        });
      },
    };
  }

  /**
   * Log HTTP request
   */
  http(message: string, meta: LogMeta): void {
    if (!this.shouldLog('info')) return;

    const entry = this.createLogEntry('info', message, {
      ...meta,
      tags: [...(meta.tags || []), 'http'],
    });
    this.dispatch(entry);
  }

  /**
   * Flush all pending logs
   */
  async flush(): Promise<void> {
    await Promise.all(this.transports.map((t) => t.flush()));
  }

  /**
   * Get current log level
   */
  getLevel(): LogLevel {
    return this.config.level;
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Shutdown logger and all transports
   */
  async shutdown(): Promise<void> {
    this.debug('SDKLogger shutting down', {
      operation: 'shutdown',
      component: 'SDKLogger',
    });

    await this.flush();
    await Promise.all(this.transports.map((t) => t.shutdown()));
    this.initialized = false;
  }

  /**
   * Add a custom transport
   */
  addTransport(transport: ILogTransport): void {
    this.transports.push(transport);
    if (this.initialized) {
      transport.initialize().catch((err) => {
        console.error(`[SDKLogger] Failed to initialize transport ${transport.name}:`, err);
      });
    }
  }

  /**
   * Get list of active transport names
   */
  getTransportNames(): string[] {
    return this.transports.map((t) => t.name);
  }
}

/**
 * Create a new SDK logger instance
 */
export function createSDKLogger(config?: Partial<LoggerConfig>): SDKLogger {
  return new SDKLogger(config);
}

/**
 * Global singleton logger instance
 */
let globalLogger: SDKLogger | null = null;

/**
 * Get or create the global logger instance
 */
export function getGlobalLogger(config?: Partial<LoggerConfig>): SDKLogger {
  if (!globalLogger) {
    globalLogger = createSDKLogger(config);
  }
  return globalLogger;
}

/**
 * Set the global logger instance
 */
export function setGlobalLogger(logger: SDKLogger): void {
  globalLogger = logger;
}
