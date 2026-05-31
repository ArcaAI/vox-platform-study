/**
 * Transport types and interfaces for the pluggable logging system
 *
 * This module defines the core abstractions for log transports that can send
 * logs to various destinations (console, file, Loki, Highlight.io, etc.)
 */

/**
 * Supported log levels matching Pino's level system
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Log entry structure passed to transports
 */
export interface LogEntry {
  /** Log level */
  level: LogLevel;

  /** Pino numeric level (10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal) */
  levelNumber: number;

  /** Log message */
  message: string;

  /** ISO timestamp */
  timestamp: string;

  /** Unix timestamp in milliseconds */
  timestampMs: number;

  /** Logger context (usually class/service name) */
  context?: string;

  /** OpenTelemetry trace ID (if available) */
  traceId?: string;

  /** OpenTelemetry span ID (if available) */
  spanId?: string;

  /** Request ID (if available) */
  requestId?: string;

  /** User ID (if available) */
  userId?: string;

  /** Tenant ID (if available) */
  tenantId?: string;

  /** Error object (for error logs) */
  error?: Error | Record<string, unknown>;

  /** Additional metadata */
  meta?: Record<string, unknown>;

  /** Service name */
  serviceName?: string;

  /** Service version */
  serviceVersion?: string;

  /** Environment (development, staging, production) */
  environment?: string;

  /** Hostname */
  hostname?: string;

  /** Process ID */
  pid?: number;
}

/**
 * Transport lifecycle states
 */
export type TransportState = 'initialized' | 'running' | 'stopped' | 'error';

/**
 * Base configuration for all transports
 */
export interface BaseTransportConfig {
  /** Transport name for identification */
  name: string;

  /** Minimum log level to process */
  level?: LogLevel;

  /** Whether the transport is enabled */
  enabled?: boolean;

  /** Log levels to include (if specified, only these levels are processed) */
  includeLevels?: LogLevel[];

  /** Log levels to exclude */
  excludeLevels?: LogLevel[];
}

/**
 * Console transport configuration
 */
export interface ConsoleTransportConfig extends BaseTransportConfig {
  name: 'console';

  /** Enable colorized output (development only) */
  colorize?: boolean;

  /** Use pretty printing (development only) */
  prettyPrint?: boolean;

  /** Include timestamp in output */
  includeTimestamp?: boolean;

  /** Include hostname in output */
  includeHostname?: boolean;

  /** Include PID in output */
  includePid?: boolean;

  /** JSON output format (for production) */
  json?: boolean;
}

/**
 * File transport configuration
 */
export interface FileTransportConfig extends BaseTransportConfig {
  name: 'file';

  /** Directory for log files */
  logDir: string;

  /** Maximum file size before rotation (e.g., '10m', '100k') */
  maxFileSize?: string;

  /** Maximum number of files to retain */
  maxFiles?: number;

  /** Date pattern for file naming */
  datePattern?: string;

  /** Separate error logs to a different file */
  separateErrorFile?: boolean;

  /** Compress rotated files */
  compress?: boolean;
}

/**
 * Highlight.io transport configuration
 */
export interface HighlightTransportConfig extends BaseTransportConfig {
  name: 'highlight';

  /** Highlight.io project ID */
  projectId: string;

  /** Service name to display in Highlight */
  serviceName?: string;

  /** Service version */
  serviceVersion?: string;

  /** Custom backend URL (for self-hosted) */
  backendUrl?: string;

  /** OTLP endpoint (alternative to backendUrl) */
  otlpEndpoint?: string;
}

/**
 * Loki (Grafana) transport configuration
 */
export interface LokiTransportConfig extends BaseTransportConfig {
  name: 'loki';

  /** Loki server host URL */
  host: string;

  /** Basic auth credentials (user:password) */
  basicAuth?: string;

  /** Custom headers (e.g., X-Scope-OrgID for multi-tenant) */
  headers?: Record<string, string>;

  /** Labels to add to all logs */
  labels?: Record<string, string>;

  /** Batch interval in milliseconds */
  batchInterval?: number;

  /** Maximum batch size */
  batchSize?: number;

  /** Request timeout in milliseconds */
  timeout?: number;

  /** Properties to convert to Loki labels */
  propsToLabels?: string[];
}

/**
 * OpenTelemetry transport configuration
 */
export interface OTelTransportConfig extends BaseTransportConfig {
  name: 'otel';

  /** OTLP endpoint URL */
  endpoint: string;

  /** Protocol: 'http/protobuf' or 'http/json' */
  protocol?: 'http/protobuf' | 'http/json' | 'grpc';

  /** Service name */
  serviceName: string;

  /** Service version */
  serviceVersion?: string;

  /** Custom headers for authentication */
  headers?: Record<string, string>;

  /** Enable trace context injection */
  injectTraceContext?: boolean;

  /** Resource attributes */
  resourceAttributes?: Record<string, string>;
}

/**
 * OpenTelemetry Log Bridge transport configuration
 * Bridges LoggingService to the OTel Logs API (logger.emit())
 */
export interface OTelLogBridgeTransportConfig extends BaseTransportConfig {
  name: 'otel-bridge';
  serviceName: string;
  serviceVersion?: string;
}

/**
 * Union type for all transport configurations
 */
export type TransportConfig =
  | ConsoleTransportConfig
  | FileTransportConfig
  | HighlightTransportConfig
  | LokiTransportConfig
  | OTelTransportConfig
  | OTelLogBridgeTransportConfig;

/**
 * Transport interface that all transports must implement
 */
export interface ILogTransport {
  /** Transport name */
  readonly name: string;

  /** Current state */
  readonly state: TransportState;

  /** Configuration */
  readonly config: BaseTransportConfig;

  /**
   * Initialize the transport
   * Called once during logging service startup
   */
  initialize(): Promise<void>;

  /**
   * Process a log entry
   * @param entry - The log entry to process
   */
  log(entry: LogEntry): void;

  /**
   * Flush any pending logs
   * Called during graceful shutdown
   */
  flush(): Promise<void>;

  /**
   * Shutdown the transport
   * Release resources and close connections
   */
  shutdown(): Promise<void>;

  /**
   * Check if this transport should process a given log level
   * @param level - The log level to check
   */
  shouldLog(level: LogLevel): boolean;
}

/**
 * Transport factory function type
 */
export type TransportFactory<T extends TransportConfig = TransportConfig> = (config: T) => ILogTransport;

/**
 * Logging configuration
 */
export interface LoggingConfig {
  /** Global log level */
  level: LogLevel;

  /** Service name */
  serviceName: string;

  /** Service version */
  serviceVersion?: string;

  /** Environment */
  environment: string;

  /** Transport configurations */
  transports: TransportConfig[];

  /** Default context for logs */
  defaultContext?: string;

  /** Enable OpenTelemetry trace context injection */
  enableTraceContext?: boolean;

  /** Redact sensitive fields from logs */
  redactFields?: string[];

  /** Maximum message length (truncate if exceeded) */
  maxMessageLength?: number;
}

/**
 * Log level numeric values (matches Pino)
 */
export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * Convert numeric level to LogLevel
 */
export function numericToLevel(num: number): LogLevel {
  if (num >= 60) return 'fatal';
  if (num >= 50) return 'error';
  if (num >= 40) return 'warn';
  if (num >= 30) return 'info';
  if (num >= 20) return 'debug';
  return 'trace';
}

/**
 * Check if a level should be logged based on minimum level
 */
export function shouldLogLevel(level: LogLevel, minLevel: LogLevel): boolean {
  return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[minLevel];
}
