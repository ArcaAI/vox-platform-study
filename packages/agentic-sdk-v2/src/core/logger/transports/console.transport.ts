/**
 * @arcaai/vox - Console Transport
 *
 * Console transport for browser and Node.js environments with support for:
 * - Colorized output (development)
 * - JSON output (production)
 * - Pretty printing
 * - Log level filtering
 */

import type { ILogTransport, LogEntry, ConsoleTransportConfig, LogLevel } from '../types';
import { LOG_LEVEL_VALUES } from '../types';
import { safeStringify } from '../utils';

/**
 * ANSI color codes for terminal output
 */
const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
} as const;

/**
 * Log level colors
 */
const LEVEL_COLORS: Record<LogLevel, string> = {
  trace: COLORS.dim,
  debug: COLORS.cyan,
  info: COLORS.green,
  warn: COLORS.yellow,
  error: COLORS.red,
  fatal: `${COLORS.bgRed}${COLORS.white}`,
};

/**
 * Log level labels
 */
const LEVEL_LABELS: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
  fatal: 'FATAL',
};

/**
 * Console transport implementation
 */
export class ConsoleTransport implements ILogTransport {
  readonly name = 'console';
  private config: ConsoleTransportConfig;
  private level: LogLevel;

  constructor(config: ConsoleTransportConfig) {
    this.config = config;
    this.level = config.level || 'info';
  }

  async initialize(): Promise<void> {
    // No initialization needed for console
  }

  /**
   * Check if level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.level];
  }

  /**
   * Format a log entry for console output
   */
  private format(entry: LogEntry): string {
    if (!this.config.prettyPrint) {
      // JSON format for production
      return safeStringify(this.toPlainObject(entry));
    }

    // Pretty format for development
    const parts: string[] = [];

    // Timestamp
    if (this.config.includeTimestamp !== false) {
      const time = new Date(entry.timestamp).toISOString().slice(11, 23);
      parts.push(this.colorize(time, COLORS.dim));
    }

    // Level
    const levelLabel = LEVEL_LABELS[entry.level];
    if (this.config.colorize !== false) {
      parts.push(`${LEVEL_COLORS[entry.level]}${levelLabel}${COLORS.reset}`);
    } else {
      parts.push(levelLabel);
    }

    // Context
    if (entry.context) {
      parts.push(this.colorize(`[${entry.context}]`, COLORS.magenta));
    }

    // Correlation ID
    if (entry.correlation?.correlationId) {
      parts.push(this.colorize(`(${entry.correlation.correlationId.slice(0, 8)})`, COLORS.dim));
    }

    // Message
    parts.push(entry.message);

    // Build metadata section
    const meta = this.buildMetaString(entry);
    if (meta) {
      parts.push(meta);
    }

    return parts.join(' ');
  }

  /**
   * Build metadata string for pretty printing
   */
  private buildMetaString(entry: LogEntry): string {
    const parts: string[] = [];

    // Operation info
    if (entry.operation?.operation) {
      parts.push(`op=${entry.operation.operation}`);
    }
    if (entry.operation?.durationMs !== undefined) {
      parts.push(`duration=${entry.operation.durationMs}ms`);
    }

    // HTTP info
    if (entry.http) {
      if (entry.http.method && entry.http.url) {
        parts.push(`${entry.http.method} ${entry.http.url}`);
      }
      if (entry.http.statusCode) {
        parts.push(`status=${entry.http.statusCode}`);
      }
      if (entry.http.responseTimeMs !== undefined) {
        parts.push(`time=${entry.http.responseTimeMs}ms`);
      }
    }

    // User info
    if (entry.user?.userId) {
      parts.push(`user=${entry.user.userId}`);
    }
    if (entry.user?.tenantId) {
      parts.push(`tenant=${entry.user.tenantId}`);
    }

    // Trace info
    if (entry.trace?.traceId) {
      parts.push(`trace=${entry.trace.traceId.slice(0, 8)}`);
    }

    // Error info
    if (entry.error) {
      if (entry.error.code) {
        parts.push(`code=${entry.error.code}`);
      }
    }

    // Additional attributes
    if (entry.attributes && Object.keys(entry.attributes).length > 0) {
      for (const [key, value] of Object.entries(entry.attributes)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          parts.push(`${key}=${value}`);
        }
      }
    }

    if (parts.length === 0) return '';
    return this.colorize(`{ ${parts.join(', ')} }`, COLORS.dim);
  }

  /**
   * Apply color if enabled
   */
  private colorize(text: string, color: string): string {
    if (this.config.colorize === false) return text;
    return `${color}${text}${COLORS.reset}`;
  }

  /**
   * Convert entry to plain object for JSON output
   */
  private toPlainObject(entry: LogEntry): Record<string, unknown> {
    const obj: Record<string, unknown> = {
      timestamp: entry.timestampIso,
      level: entry.level,
      message: entry.message,
    };

    if (entry.context) obj.context = entry.context;
    if (entry.correlation?.correlationId) obj.correlationId = entry.correlation.correlationId;
    if (entry.correlation?.requestId) obj.requestId = entry.correlation.requestId;
    if (entry.trace?.traceId) obj.traceId = entry.trace.traceId;
    if (entry.trace?.spanId) obj.spanId = entry.trace.spanId;
    if (entry.user?.userId) obj.userId = entry.user.userId;
    if (entry.user?.tenantId) obj.tenantId = entry.user.tenantId;
    if (entry.operation) obj.operation = entry.operation;
    if (entry.http) obj.http = entry.http;
    if (entry.error) obj.error = entry.error;
    if (entry.attributes) obj.attributes = entry.attributes;
    if (entry.tags?.length) obj.tags = entry.tags;
    if (entry.resource) obj.resource = entry.resource;

    return obj;
  }

  /**
   * Log entry to console
   */
  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    const message = this.format(entry);
    const consoleMethod = this.getConsoleMethod(entry.level);

    // Log the main message
    consoleMethod(message);

    // For errors, also log the stack trace
    if (entry.error?.stack && this.config.prettyPrint) {
      console.error(this.colorize(entry.error.stack, COLORS.dim));
    }
  }

  /**
   * Get appropriate console method for log level
   */
  private getConsoleMethod(level: LogLevel): (...args: unknown[]) => void {
    switch (level) {
      case 'trace':
        return console.trace || console.debug || console.log;
      case 'debug':
        return console.debug || console.log;
      case 'info':
        return console.info || console.log;
      case 'warn':
        return console.warn;
      case 'error':
      case 'fatal':
        return console.error;
      default:
        return console.log;
    }
  }

  async flush(): Promise<void> {
    // Console doesn't need flushing
  }

  async shutdown(): Promise<void> {
    // No cleanup needed
  }
}
