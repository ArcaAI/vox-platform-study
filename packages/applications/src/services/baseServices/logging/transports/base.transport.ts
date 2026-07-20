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
    const log: Record<string, unknown> = {
      level: entry.level,
      msg: entry.message,
      time: entry.timestamp,
      timestamp: entry.timestampMs,
    };

    if (entry.context) log.context = entry.context;
    if (entry.traceId) log.trace_id = entry.traceId;
    if (entry.spanId) log.span_id = entry.spanId;
    if (entry.requestId) log.request_id = entry.requestId;
    if (entry.userId) log.user_id = entry.userId;
    if (entry.tenantId) log.tenant_id = entry.tenantId;
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
