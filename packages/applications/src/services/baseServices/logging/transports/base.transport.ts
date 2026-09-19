/**
 * Base transport class that provides common functionality for all transports
 */

import { type BaseTransportConfig, type ILogTransport, type LogEntry, type LogLevel, type TransportState, shouldLogLevel } from './types';

/**
 * Abstract base class for log transports
 * Provides common functionality like level filtering and state management
 */
export abstract class BaseTransport implements ILogTransport {
  protected _state: TransportState = 'initialized';
  protected readonly minLevel: LogLevel;
  protected readonly includeLevels: Set<LogLevel> | null;
  protected readonly excludeLevels: Set<LogLevel>;

  constructor(public readonly config: BaseTransportConfig) {
    this.minLevel = config.level || 'trace';
    this.includeLevels = config.includeLevels ? new Set(config.includeLevels) : null;
    this.excludeLevels = new Set(config.excludeLevels || []);
  }

  get name(): string {
    return this.config.name;
  }

  get state(): TransportState {
    return this._state;
  }

  get enabled(): boolean {
    return this.config.enabled !== false;
  }

  /**
   * Check if this transport should process a given log level
   */
  shouldLog(level: LogLevel): boolean {
    // Check if transport is enabled
    if (!this.enabled) {
      return false;
    }

    // Check if level is excluded
    if (this.excludeLevels.has(level)) {
      return false;
    }

    // Check if specific levels are included
    if (this.includeLevels !== null) {
      return this.includeLevels.has(level);
    }

    // Check minimum level
    return shouldLogLevel(level, this.minLevel);
  }

  /**
   * Initialize the transport - override in subclasses
   */
  async initialize(): Promise<void> {
    this._state = 'running';
  }

  /**
   * Process a log entry - must be implemented by subclasses
   */
  abstract log(entry: LogEntry): void;

  /**
   * Flush pending logs - override in subclasses if needed
   */
  async flush(): Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Shutdown the transport - override in subclasses if needed
   */
  async shutdown(): Promise<void> {
    await this.flush();
    this._state = 'stopped';
  }

  /**
   * Format error for logging
   */
  protected formatError(error: unknown): Record<string, unknown> | undefined {
    if (!error) return undefined;

    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...((error as any).cause && { cause: this.formatError((error as any).cause) }),
      };
    }

    if (typeof error === 'object') {
      return error as Record<string, unknown>;
    }

    return { message: String(error) };
  }

  /**
   * Create a structured log object from a LogEntry
   */
  protected toStructuredLog(entry: LogEntry): Record<string, unknown> {
    // Key names are a CONTRACT with three readers, not a style choice:
    //   - Loki 3.x derives `detected_level` from a top-level `level`;
    //   - Grafana's Loki->Tempo derived field matches the literal
    //     `"traceId":"<hex>"` (deployment repo, observability-config.yaml), so
    //     a snake_case rename here silently unlinks every log line from its
    //     trace;
    //   - the six Python services emit `level` / `timestamp` / `service` /
    //     `traceId` / `spanId` through `packages/py-obs`, and one fleet that
    //     needs two spellings per field is one nobody can query.
    // `msg` / `time` / `trace_id` / `span_id` / `request_id` / `user_id` /
    // `tenant_id` were the previous spellings; nothing consumed them, because
    // this JSON path had never been selected in a deployed environment.
    const log: Record<string, unknown> = {
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
      timestampMs: entry.timestampMs,
    };

    if (entry.context) log.context = entry.context;
    if (entry.traceId) log.traceId = entry.traceId;
    if (entry.spanId) log.spanId = entry.spanId;
    if (entry.requestId) log.requestId = entry.requestId;
    if (entry.userId) log.userId = entry.userId;
    if (entry.tenantId) log.tenantId = entry.tenantId;
    if (entry.serviceName) log.service = entry.serviceName;
    if (entry.serviceVersion) log.version = entry.serviceVersion;
    if (entry.environment) log.env = entry.environment;
    if (entry.hostname) log.hostname = entry.hostname;
    if (entry.pid) log.pid = entry.pid;
    if (entry.error) log.error = this.formatError(entry.error);
    if (entry.meta && Object.keys(entry.meta).length > 0) {
      Object.assign(log, entry.meta);
    }

    return log;
  }

  /**
   * Map log level to ANSI color code
   */
  protected getLevelColor(level: LogLevel): string {
    const colors: Record<LogLevel, string> = {
      trace: '\x1b[90m', // Gray
      debug: '\x1b[36m', // Cyan
      info: '\x1b[32m', // Green
      warn: '\x1b[33m', // Yellow
      error: '\x1b[31m', // Red
      fatal: '\x1b[35m', // Magenta
    };
    return colors[level] || '\x1b[0m';
  }

  /**
   * Reset ANSI color
   */
  protected readonly resetColor = '\x1b[0m';
}
