/**
 * @arcaai/vox - Highlight.io Transport
 *
 * Transport for Highlight.io integration with support for:
 * - Error tracking and session replay
 * - Structured logging with trace context
 * - Custom attributes and tagging
 *
 * @see https://www.highlight.io/docs
 */

import type { ILogTransport, LogEntry, HighlightTransportConfig, LogLevel } from '../types';
import { LOG_LEVEL_VALUES } from '../types';

/**
 * Highlight.io SDK interface (loaded dynamically)
 */
interface HighlightInstance {
  init: (projectId: string, options?: HighlightOptions) => void;
  identify: (identifier: string, metadata?: Record<string, string>) => void;
  track: (eventName: string, metadata?: Record<string, unknown>) => void;
  start: () => void;
  stop: () => void;
  getSessionURL: () => string | undefined;
  getSessionId: () => string | undefined;
  consumeError: (error: Error, metadata?: Record<string, unknown>) => void;
  log: (message: string, level: string, attributes?: Record<string, unknown>) => void;
}

interface HighlightOptions {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  version?: string;
  enableStrictPrivacy?: boolean;
  enableCanvasRecording?: boolean;
  enablePerformanceRecording?: boolean;
  networkRecording?: {
    enabled?: boolean;
    recordHeadersAndBody?: boolean;
    urlBlocklist?: string[];
    headerSanitizer?: (key: string, value: string) => string;
  };
  privacySetting?: 'strict' | 'default' | 'none';
  debug?: boolean;
  manualStart?: boolean;
  disableSessionRecording?: boolean;
  backendUrl?: string;
}

/**
 * Highlight.io transport implementation
 */
export class HighlightTransport implements ILogTransport {
  readonly name = 'highlight';
  private config: HighlightTransportConfig;
  private highlight: HighlightInstance | null = null;
  private initialized = false;
  private pendingLogs: LogEntry[] = [];
  private level: LogLevel;

  constructor(config: HighlightTransportConfig) {
    this.config = config;
    this.level = config.level || 'info';
  }

  /**
   * Initialize Highlight.io SDK
   */
  async initialize(): Promise<void> {
    if (this.initialized || typeof window === 'undefined') {
      // Highlight.io only works in browser
      return;
    }

    try {
      // Dynamic import for browser environments
      // highlight.run is the main npm package that exports H
      const highlightModule = await import('highlight.run');
      this.highlight = highlightModule.H as unknown as HighlightInstance;

      if (!this.highlight) {
        console.warn('[HighlightTransport] Highlight.io SDK not available');
        return;
      }

      // Initialize Highlight
      this.highlight.init(this.config.projectId, {
        serviceName: this.config.serviceName,
        environment: this.config.environment,
        enableStrictPrivacy: this.config.privacySettings?.maskInputs,
        networkRecording: {
          enabled: this.config.networkRecording ?? true,
          recordHeadersAndBody: this.config.recordHeadersAndBody ?? false,
          headerSanitizer: (key, value) => {
            // Redact sensitive headers
            const sensitiveHeaders = ['authorization', 'x-api-key', 'cookie'];
            if (sensitiveHeaders.includes(key.toLowerCase())) {
              return '[REDACTED]';
            }
            return value;
          },
        },
        debug: false,
        manualStart: false,
      });

      this.initialized = true;

      // Flush pending logs
      for (const entry of this.pendingLogs) {
        this.log(entry);
      }
      this.pendingLogs = [];
    } catch (error) {
      console.warn('[HighlightTransport] Failed to initialize:', error);
    }
  }

  /**
   * Check if level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.level];
  }

  /**
   * Log entry to Highlight.io
   */
  log(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) return;

    if (!this.initialized || !this.highlight) {
      // Queue for later if not initialized
      this.pendingLogs.push(entry);
      return;
    }

    // Build attributes for Highlight
    const attributes = this.buildAttributes(entry);

    // Map log level to Highlight level
    const highlightLevel = this.mapLevel(entry.level);

    // Log to Highlight
    this.highlight.log(entry.message, highlightLevel, attributes);

    // For errors, also report as error event for better tracking
    if (entry.level === 'error' || entry.level === 'fatal') {
      this.reportError(entry);
    }

    // Track as custom event if it's an operation completion
    if (entry.operation?.operation && entry.operation.durationMs !== undefined) {
      this.trackOperation(entry);
    }
  }

  /**
   * Build attributes object for Highlight
   */
  private buildAttributes(entry: LogEntry): Record<string, unknown> {
    const attrs: Record<string, unknown> = {
      timestamp: entry.timestampIso,
      severityNumber: entry.severityNumber,
    };

    // Context
    if (entry.context) attrs.context = entry.context;

    // Correlation/Trace context
    if (entry.correlation?.correlationId) attrs.correlationId = entry.correlation.correlationId;
    if (entry.correlation?.requestId) attrs.requestId = entry.correlation.requestId;
    if (entry.correlation?.sessionId) attrs.sessionId = entry.correlation.sessionId;
    if (entry.trace?.traceId) attrs.traceId = entry.trace.traceId;
    if (entry.trace?.spanId) attrs.spanId = entry.trace.spanId;

    // User context
    if (entry.user?.userId) attrs.userId = entry.user.userId;
    if (entry.user?.tenantId) attrs.tenantId = entry.user.tenantId;
    if (entry.user?.doctorId) attrs.doctorId = entry.user.doctorId;
    if (entry.user?.patientId) attrs.patientId = entry.user.patientId;

    // Operation context
    if (entry.operation) {
      if (entry.operation.operation) attrs.operation = entry.operation.operation;
      if (entry.operation.component) attrs.component = entry.operation.component;
      if (entry.operation.durationMs !== undefined) attrs.durationMs = entry.operation.durationMs;
      if (entry.operation.success !== undefined) attrs.success = entry.operation.success;
    }

    // HTTP context
    if (entry.http) {
      if (entry.http.method) attrs.httpMethod = entry.http.method;
      if (entry.http.url) attrs.httpUrl = entry.http.url;
      if (entry.http.statusCode) attrs.httpStatus = entry.http.statusCode;
      if (entry.http.responseTimeMs !== undefined) attrs.httpDuration = entry.http.responseTimeMs;
    }

    // SDK context
    if (entry.sdk?.consultationId) attrs.consultationId = entry.sdk.consultationId;
    if (entry.sdk?.modelId) attrs.modelId = entry.sdk.modelId;

    // Error context
    if (entry.error) {
      attrs.errorCode = entry.error.code;
      attrs.errorName = entry.error.name;
      attrs.errorMessage = entry.error.stack?.split('\n')[0];
    }

    // Additional attributes
    if (entry.attributes) {
      Object.assign(attrs, entry.attributes);
    }

    // Tags
    if (entry.tags?.length) {
      attrs.tags = entry.tags.join(',');
    }

    // Resource info
    if (entry.resource) {
      attrs.service = entry.resource.serviceName;
      attrs.version = entry.resource.serviceVersion || entry.resource.sdkVersion;
      attrs.environment = entry.resource.environment;
    }

    return attrs;
  }

  /**
   * Map SDK log level to Highlight level
   */
  private mapLevel(level: LogLevel): string {
    switch (level) {
      case 'trace':
        return 'trace';
      case 'debug':
        return 'debug';
      case 'info':
        return 'info';
      case 'warn':
        return 'warn';
      case 'error':
        return 'error';
      case 'fatal':
        return 'fatal';
      default:
        return 'info';
    }
  }

  /**
   * Report error to Highlight.io error tracking
   */
  private reportError(entry: LogEntry): void {
    if (!this.highlight) return;

    const error = entry.error ? (entry.error.stack ? new Error(entry.message) : new Error(entry.message)) : new Error(entry.message);

    // Set error properties
    if (entry.error?.name) {
      error.name = entry.error.name;
    }
    if (entry.error?.stack) {
      error.stack = entry.error.stack;
    }

    this.highlight.consumeError(error, {
      context: entry.context,
      correlationId: entry.correlation?.correlationId,
      requestId: entry.correlation?.requestId,
      traceId: entry.trace?.traceId,
      userId: entry.user?.userId,
      tenantId: entry.user?.tenantId,
      operation: entry.operation?.operation,
      errorCode: entry.error?.code,
      ...entry.attributes,
    });
  }

  /**
   * Track operation as custom event
   */
  private trackOperation(entry: LogEntry): void {
    if (!this.highlight || !entry.operation) return;

    this.highlight.track(`operation.${entry.operation.operation}`, {
      component: entry.operation.component,
      durationMs: entry.operation.durationMs,
      success: entry.operation.success,
      correlationId: entry.correlation?.correlationId,
      userId: entry.user?.userId,
      ...entry.attributes,
    });
  }

  /**
   * Identify user in Highlight session
   */
  identify(userId: string, metadata?: Record<string, string>): void {
    if (!this.highlight) return;
    this.highlight.identify(userId, metadata);
  }

  /**
   * Get current Highlight session URL
   */
  getSessionURL(): string | undefined {
    return this.highlight?.getSessionURL();
  }

  /**
   * Get current Highlight session ID
   */
  getSessionId(): string | undefined {
    return this.highlight?.getSessionId();
  }

  async flush(): Promise<void> {
    // Highlight.io SDK handles batching internally
  }

  async shutdown(): Promise<void> {
    if (this.highlight) {
      this.highlight.stop();
    }
    this.initialized = false;
  }
}
