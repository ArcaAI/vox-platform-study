/**
 * Console transport for logging to stdout/stderr
 *
 * Supports two modes:
 * - Pretty print (development): Colorized, human-readable output
 * - JSON (production): Structured JSON for log aggregation
 */

import { BaseTransport } from './base.transport';
import type { ConsoleTransportConfig, LogEntry, LogLevel } from './types';

/**
 * Console transport implementation
 */
export class ConsoleTransport extends BaseTransport {
  private readonly colorize: boolean;
  private readonly prettyPrint: boolean;
  private readonly includeTimestamp: boolean;
  private readonly includeHostname: boolean;
  private readonly includePid: boolean;
  private readonly json: boolean;

  constructor(config: ConsoleTransportConfig) {
    super(config);
    this.colorize = config.colorize ?? process.env.NODE_ENV === 'development';
    this.prettyPrint = config.prettyPrint ?? process.env.NODE_ENV === 'development';
    this.includeTimestamp = config.includeTimestamp ?? true;
    this.includeHostname = config.includeHostname ?? false;
    this.includePid = config.includePid ?? false;
    this.json = config.json ?? process.env.NODE_ENV !== 'development';
  }

  /**
   * Log entry to console
   */
  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    const output = this.json ? this.formatJson(entry) : this.formatPretty(entry);

    // Use stderr for error and fatal levels
    const stream = entry.levelNumber >= 50 ? process.stderr : process.stdout;
    stream.write(output + '\n');
  }

  /**
   * Format log entry as JSON
   */
  private formatJson(entry: LogEntry): string {
    const log = this.toStructuredLog(entry);
    return JSON.stringify(log);
  }

  /**
   * Format log entry as human-readable pretty print
   */
  private formatPretty(entry: LogEntry): string {
    const parts: string[] = [];

    // Timestamp
    if (this.includeTimestamp) {
      const timestamp = this.formatTimestamp(entry.timestamp);
      parts.push(this.colorize ? `\x1b[90m${timestamp}\x1b[0m` : timestamp);
    }

    // PID
    if (this.includePid && entry.pid) {
      parts.push(this.colorize ? `\x1b[90m[${entry.pid}]\x1b[0m` : `[${entry.pid}]`);
    }

    // Log level
    const levelStr = this.formatLevel(entry.level);
    parts.push(levelStr);

    // Context
    if (entry.context) {
      const ctx = `[${entry.context}]`;
      parts.push(this.colorize ? `\x1b[33m${ctx}\x1b[0m` : ctx);
    }

    // Message
    parts.push(entry.message);

    // Trace context
    if (entry.traceId) {
      const trace = `trace=${entry.traceId.substring(0, 8)}...`;
      parts.push(this.colorize ? `\x1b[90m${trace}\x1b[0m` : trace);
    }

    // Request ID
    if (entry.requestId) {
      const reqId = `req=${entry.requestId.substring(0, 8)}...`;
      parts.push(this.colorize ? `\x1b[90m${reqId}\x1b[0m` : reqId);
    }

    // Error details
    if (entry.error) {
      const errorStr = this.formatErrorPretty(entry.error);
      parts.push('\n' + errorStr);
    }

    // Additional metadata
    if (entry.meta && Object.keys(entry.meta).length > 0) {
      const metaStr = this.formatMetaPretty(entry.meta);
      if (metaStr) {
        parts.push(this.colorize ? `\x1b[90m${metaStr}\x1b[0m` : metaStr);
      }
    }

    return parts.join(' ');
  }

  /**
   * Format timestamp for pretty print
   */
  private formatTimestamp(isoTimestamp: string): string {
    try {
      const date = new Date(isoTimestamp);
      const hours = date.getHours().toString().padStart(2, '0');
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const seconds = date.getSeconds().toString().padStart(2, '0');
      const ms = date.getMilliseconds().toString().padStart(3, '0');
      return `${hours}:${minutes}:${seconds}.${ms}`;
    } catch {
      return isoTimestamp;
    }
  }

  /**
   * Format log level for pretty print
   */
  private formatLevel(level: LogLevel): string {
    const levelStr = level.toUpperCase().padEnd(5);

    if (!this.colorize) {
      return levelStr;
    }

    const color = this.getLevelColor(level);
    return `${color}${levelStr}${this.resetColor}`;
  }

  /**
   * Format error for pretty print
   */
  private formatErrorPretty(error: Error | Record<string, unknown>): string {
    if (error instanceof Error) {
      const lines: string[] = [];
      const color = this.colorize ? '\x1b[31m' : '';
      const reset = this.colorize ? '\x1b[0m' : '';

      lines.push(`${color}Error: ${error.message}${reset}`);

      if (error.stack) {
        const stackLines = error.stack.split('\n').slice(1);
        const formattedStack = stackLines.map((line) => `  ${this.colorize ? '\x1b[90m' : ''}${line.trim()}${reset}`).join('\n');
        lines.push(formattedStack);
      }

      return lines.join('\n');
    }

    // Handle plain object errors
    return this.colorize ? `\x1b[31m${JSON.stringify(error, null, 2)}\x1b[0m` : JSON.stringify(error, null, 2);
  }

  /**
   * Format metadata for pretty print
   */
  private formatMetaPretty(meta: Record<string, unknown>): string {
    // Filter out empty or undefined values
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const filtered = Object.entries(meta).filter(([_, value]) => value !== undefined && value !== null && value !== '');

    if (filtered.length === 0) {
      return '';
    }

    // Format as key=value pairs
    const pairs = filtered.map(([key, value]) => {
      const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${valueStr}`;
    });

    return `{ ${pairs.join(', ')} }`;
  }
}

/**
 * Factory function to create a console transport
 */
export function createConsoleTransport(config: Partial<ConsoleTransportConfig> = {}): ConsoleTransport {
  return new ConsoleTransport({
    name: 'console',
    enabled: true,
    ...config,
  });
}
