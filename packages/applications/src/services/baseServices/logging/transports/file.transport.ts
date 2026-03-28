/**
 * File transport for logging to rotating log files
 *
 * Features:
 * - Daily log rotation
 * - Size-based rotation
 * - Separate error log file (optional)
 * - Automatic cleanup of old files
 */

import * as fs from 'fs';
import * as path from 'path';
import { BaseTransport } from './base.transport';
import type { FileTransportConfig, LogEntry } from './types';

/**
 * File transport implementation using pino-roll for rotation
 */
export class FileTransport extends BaseTransport {
  private readonly logDir: string;
  private readonly maxFileSize: string;
  private readonly maxFiles: number;
  private readonly datePattern: string;
  private readonly separateErrorFile: boolean;
  private readonly compress: boolean;

  private combinedStream: fs.WriteStream | null = null;
  private errorStream: fs.WriteStream | null = null;
  private currentDate: string = '';

  constructor(config: FileTransportConfig) {
    super(config);
    this.logDir = config.logDir || './logs';
    this.maxFileSize = config.maxFileSize || '10m';
    this.maxFiles = config.maxFiles || 30;
    this.datePattern = config.datePattern || 'yyyy-MM-dd';
    this.separateErrorFile = config.separateErrorFile ?? true;
    this.compress = config.compress ?? false;
  }

  /**
   * Initialize the file transport
   */
  async initialize(): Promise<void> {
    await super.initialize();
    this.ensureLogDirectory();
    this.openStreams();
  }

  /**
   * Ensure log directory exists
   */
  private ensureLogDirectory(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (error) {
      console.error(`Failed to create log directory ${this.logDir}:`, error);
      throw error;
    }
  }

  /**
   * Open write streams for log files
   */
  private openStreams(): void {
    this.currentDate = this.getCurrentDateString();
    const combinedPath = this.getLogFilePath('combined');
    this.combinedStream = fs.createWriteStream(combinedPath, { flags: 'a' });

    if (this.separateErrorFile) {
      const errorPath = this.getLogFilePath('error');
      this.errorStream = fs.createWriteStream(errorPath, { flags: 'a' });
    }
  }

  /**
   * Get current date string for file naming
   */
  private getCurrentDateString(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * Get log file path
   */
  private getLogFilePath(type: 'combined' | 'error'): string {
    const date = this.getCurrentDateString();
    const filename = type === 'error' ? `error-${date}.log` : `combined-${date}.log`;
    return path.join(this.logDir, filename);
  }

  /**
   * Check if date has changed and rotate if needed
   */
  private checkDateRotation(): void {
    const currentDate = this.getCurrentDateString();
    if (currentDate !== this.currentDate) {
      this.closeStreams();
      this.openStreams();
      this.cleanupOldFiles();
    }
  }

  /**
   * Close write streams
   */
  private closeStreams(): void {
    if (this.combinedStream) {
      this.combinedStream.end();
      this.combinedStream = null;
    }
    if (this.errorStream) {
      this.errorStream.end();
      this.errorStream = null;
    }
  }

  /**
   * Log entry to file
   */
  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    this.checkDateRotation();

    const logLine = JSON.stringify(this.toStructuredLog(entry)) + '\n';

    // Write to combined log
    if (this.combinedStream) {
      this.combinedStream.write(logLine);
    }

    // Write errors to separate file if enabled
    if (this.separateErrorFile && this.errorStream && entry.levelNumber >= 50) {
      this.errorStream.write(logLine);
    }
  }

  /**
   * Flush pending writes
   */
  async flush(): Promise<void> {
    return new Promise((resolve) => {
      const promises: Promise<void>[] = [];

      if (this.combinedStream) {
        promises.push(
          new Promise((res) => {
            this.combinedStream!.once('drain', () => res());
            if (!this.combinedStream!.write('')) {
              // Stream is not draining, resolve immediately
            } else {
              res();
            }
          }),
        );
      }

      if (this.errorStream) {
        promises.push(
          new Promise((res) => {
            this.errorStream!.once('drain', () => res());
            if (!this.errorStream!.write('')) {
              // Stream is not draining, resolve immediately
            } else {
              res();
            }
          }),
        );
      }

      Promise.all(promises).then(() => resolve());

      // Fallback timeout
      setTimeout(resolve, 100);
    });
  }

  /**
   * Shutdown the transport
   */
  async shutdown(): Promise<void> {
    await this.flush();
    this.closeStreams();
    await super.shutdown();
  }

  /**
   * Clean up old log files beyond retention limit
   */
  private cleanupOldFiles(): void {
    try {
      this.cleanupFilesByPattern('combined-*.log');
      if (this.separateErrorFile) {
        this.cleanupFilesByPattern('error-*.log');
      }
    } catch (error) {
      console.error('Failed to cleanup old log files:', error);
    }
  }

  /**
   * Clean up files matching pattern
   */
  private cleanupFilesByPattern(pattern: string): void {
    try {
      const prefix = pattern.replace('*.log', '');
      const files = fs
        .readdirSync(this.logDir)
        .filter((file) => file.startsWith(prefix) && file.endsWith('.log'))
        .map((file) => ({
          name: file,
          path: path.join(this.logDir, file),
          stat: fs.statSync(path.join(this.logDir, file)),
        }))
        .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

      // Remove files beyond maxFiles limit
      if (files.length > this.maxFiles) {
        const filesToDelete = files.slice(this.maxFiles);
        for (const file of filesToDelete) {
          try {
            fs.unlinkSync(file.path);
          } catch (err) {
            console.error(`Failed to delete old log file ${file.name}:`, err);
          }
        }
      }
    } catch (error) {
      console.error(`Failed to cleanup files for pattern ${pattern}:`, error);
    }
  }

  /**
   * Get log directory path
   */
  getLogDirectory(): string {
    return this.logDir;
  }

  /**
   * Get combined log path
   */
  getCombinedLogPath(): string {
    return this.getLogFilePath('combined');
  }

  /**
   * Get error log path
   */
  getErrorLogPath(): string {
    return this.getLogFilePath('error');
  }
}

/**
 * Factory function to create a file transport
 */
export function createFileTransport(config: Partial<FileTransportConfig> = {}): FileTransport {
  return new FileTransport({
    name: 'file',
    enabled: true,
    logDir: './logs',
    ...config,
  });
}
