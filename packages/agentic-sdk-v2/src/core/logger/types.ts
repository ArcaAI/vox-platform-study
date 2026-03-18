/**
 * @arcaai/vox - Logger Types
 *
 * Type definitions for the SDK logging system with support for:
 * - Highlight.io (error tracking and monitoring)
 * - Grafana Stack (Loki, Tempo, Mimir)
 * - OpenTelemetry with correlation ID tracing
 */

// =============================================================================
// Log Levels
// =============================================================================

/**
 * Supported log levels (aligned with OpenTelemetry severity)
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Log level numeric values for comparison (OpenTelemetry aligned)
 */
export const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  trace: 1,
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  fatal: 21,
} as const;

// =============================================================================
// Trace Context (OpenTelemetry)
// =============================================================================

/**
 * OpenTelemetry trace context for distributed tracing
 */
export interface TraceContext {
  /** OpenTelemetry trace ID (128-bit, 32 hex chars) */
  traceId?: string;
  /** OpenTelemetry span ID (64-bit, 16 hex chars) */
  spanId?: string;
  /** Parent span ID for nested operations */
  parentSpanId?: string;
  /** Trace flags (sampling, etc.) */
  traceFlags?: number;
}

/**
 * Correlation context for request tracing across services
 */
export interface CorrelationContext extends TraceContext {
  /** SDK-generated correlation ID for cross-service tracing */
  correlationId?: string;
  /** HTTP request ID from the API gateway */
  requestId?: string;
  /** Session ID for user session tracking */
  sessionId?: string;
}

// =============================================================================
// Log Metadata
// =============================================================================

/**
 * User context for logging
 */
export interface UserContext {
  /** User ID */
  userId?: string;
  /** Tenant ID for multi-tenant applications */
  tenantId?: string;
  /** Doctor ID (specific to ARCAAI) */
  doctorId?: string;
  /** Patient ID (specific to ARCAAI) */
  patientId?: string;
}

/**
 * Operation context for structured logging
 */
export interface OperationContext {
  /** Operation name (e.g., 'createConsultation', 'startAudio') */
  operation?: string;
  /** Component name (e.g., 'AgenticClient', 'PluginManager') */
  component?: string;
  /** Module name */
  module?: string;
  /** Duration of operation in milliseconds */
  durationMs?: number;
  /** Whether operation succeeded */
  success?: boolean;
}

/**
 * Error context for error logging
 */
export interface ErrorContext {
  /** Error code */
  code?: string;
  /** Error name/type */
  name?: string;
  /** Stack trace */
  stack?: string;
  /** Original error (for wrapped errors) */
  cause?: unknown;
  /** HTTP status code (for API errors) */
  httpStatus?: number;
  /** Endpoint that failed */
  endpoint?: string;
}

/**
 * Structured log metadata
 */
export interface LogMeta extends Partial<CorrelationContext>, Partial<UserContext>, Partial<OperationContext> {
  /** Error context */
  error?: ErrorContext | Error;
  /** HTTP request metadata */
  http?: HttpMeta;
  /** SDK-specific metadata */
  sdk?: SDKMeta;
  /** Custom key-value attributes */
  attributes?: Record<string, unknown>;
  /** Tags for filtering/grouping */
  tags?: string[];
}

/**
 * HTTP request/response metadata
 */
export interface HttpMeta {
  /** HTTP method */
  method?: string;
  /** Request URL/path */
  url?: string;
  /** Response status code */
  statusCode?: number;
  /** Response time in milliseconds */
  responseTimeMs?: number;
  /** Request size in bytes */
  requestSize?: number;
  /** Response size in bytes */
  responseSize?: number;
  /** User agent string */
  userAgent?: string;
}

/**
 * SDK-specific metadata
 */
export interface SDKMeta {
  /** SDK version */
  version?: string;
  /** Active consultation ID */
  consultationId?: string;
  /** Active plugin states */
  plugins?: Record<string, boolean>;
  /** Audio capture state */
  audioCapturing?: boolean;
  /** Model being used */
  modelId?: string;
}

// =============================================================================
// Log Entry
// =============================================================================

/**
 * Complete log entry structure
 * Compatible with OpenTelemetry log data model
 */
export interface LogEntry {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** ISO 8601 timestamp string */
  timestampIso: string;
  /** Log level */
  level: LogLevel;
  /** OpenTelemetry severity number */
  severityNumber: number;
  /** Log message */
  message: string;
  /** Logger context (usually component/class name) */
  context?: string;
  /** Trace context for distributed tracing */
  trace?: TraceContext;
  /** Correlation context */
  correlation?: CorrelationContext;
  /** User context */
  user?: UserContext;
  /** Operation context */
  operation?: OperationContext;
  /** Error details */
  error?: ErrorContext;
  /** HTTP metadata */
  http?: HttpMeta;
  /** SDK metadata */
  sdk?: SDKMeta;
  /** Additional attributes */
  attributes?: Record<string, unknown>;
  /** Tags */
  tags?: string[];
  /** Service/app information */
  resource?: ResourceInfo;
}

/**
 * Resource information (OpenTelemetry resource)
 */
export interface ResourceInfo {
  /** Service name */
  serviceName: string;
  /** Service version */
  serviceVersion?: string;
  /** SDK name */
  sdkName: string;
  /** SDK version */
  sdkVersion: string;
  /** Environment (development, staging, production) */
  environment?: string;
  /** Browser/platform info */
  platform?: string;
  /** Device type */
  deviceType?: 'web' | 'mobile' | 'desktop';
}

// =============================================================================
// Logger Configuration
// =============================================================================

/**
 * Console transport configuration
 */
export interface ConsoleTransportConfig {
  /** Enable console output */
  enabled: boolean;
  /** Minimum log level */
  level?: LogLevel;
  /** Enable colorized output */
  colorize?: boolean;
  /** Pretty print JSON */
  prettyPrint?: boolean;
  /** Include timestamp */
  includeTimestamp?: boolean;
}

/**
 * Highlight.io transport configuration
 */
export interface HighlightTransportConfig {
  /** Enable Highlight.io */
  enabled: boolean;
  /** Highlight.io project ID */
  projectId: string;
  /** Service name (displayed in Highlight) */
  serviceName?: string;
  /** Environment name */
  environment?: string;
  /** Enable network recording */
  networkRecording?: boolean;
  /** Record request/response headers and bodies. Defaults to false for HIPAA compliance. */
  recordHeadersAndBody?: boolean;
  /** Privacy settings */
  privacySettings?: {
    /** Mask inputs */
    maskInputs?: boolean;
    /** Mask text content */
    maskTextContent?: boolean;
  };
}

/**
 * Grafana/Loki transport configuration
 */
export interface LokiTransportConfig {
  /** Enable Loki transport */
  enabled: boolean;
  /** Loki server URL */
  url: string;
  /** Basic auth (username:password) */
  basicAuth?: string;
  /** Custom headers */
  headers?: Record<string, string>;
  /** Labels to add to all logs */
  labels?: Record<string, string>;
  /** Batch interval in milliseconds */
  batchIntervalMs?: number;
  /** Maximum batch size */
  maxBatchSize?: number;
}

/**
 * OpenTelemetry transport configuration
 */
export interface OTelTransportConfig {
  /** Enable OpenTelemetry */
  enabled: boolean;
  /** OTLP endpoint URL */
  endpoint: string;
  /** Protocol type */
  protocol?: 'http/json' | 'http/protobuf' | 'grpc';
  /** Custom headers (e.g., for authentication) */
  headers?: Record<string, string>;
  /** Resource attributes */
  resourceAttributes?: Record<string, string>;
  /** Enable trace context propagation */
  propagateTraceContext?: boolean;
  /** Sampling ratio (0-1) */
  samplingRatio?: number;
}

/**
 * Custom transport interface
 */
export interface ILogTransport {
  /** Transport name */
  name: string;
  /** Initialize transport */
  initialize(): Promise<void>;
  /** Log entry */
  log(entry: LogEntry): void;
  /** Flush pending logs */
  flush(): Promise<void>;
  /** Shutdown transport */
  shutdown(): Promise<void>;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Global log level */
  level: LogLevel;
  /** Enable debug mode (more verbose) */
  debug?: boolean;
  /** Service/app name */
  serviceName?: string;
  /** Service version */
  serviceVersion?: string;
  /** Environment */
  environment?: string;
  /** Console transport */
  console?: ConsoleTransportConfig;
  /** Highlight.io transport */
  highlight?: HighlightTransportConfig;
  /** Grafana Loki transport */
  loki?: LokiTransportConfig;
  /** OpenTelemetry transport */
  otel?: OTelTransportConfig;
  /** Custom transports */
  customTransports?: ILogTransport[];
  /** Default context */
  defaultContext?: string;
  /** Sensitive fields to redact */
  redactFields?: string[];
  /** Maximum message length */
  maxMessageLength?: number;
  /** Enable auto correlation ID generation */
  autoCorrelationId?: boolean;
}

// =============================================================================
// Logger Interface
// =============================================================================

/**
 * SDK Logger interface
 */
export interface ISDKLogger {
  /** Log fatal message */
  fatal(message: string, meta?: LogMeta): void;
  /** Log error message */
  error(message: string, meta?: LogMeta | Error): void;
  /** Log warning message */
  warn(message: string, meta?: LogMeta): void;
  /** Log info message */
  info(message: string, meta?: LogMeta): void;
  /** Log debug message */
  debug(message: string, meta?: LogMeta): void;
  /** Log trace message */
  trace(message: string, meta?: LogMeta): void;

  /** Create child logger with context */
  child(context: string): ISDKLogger;
  /** Create logger with default metadata */
  withMeta(meta: LogMeta): ISDKLogger;
  /** Create logger with correlation context */
  withCorrelation(correlation: CorrelationContext): ISDKLogger;
  /** Create logger with user context */
  withUser(user: UserContext): ISDKLogger;

  /** Set global correlation ID */
  setCorrelationId(correlationId: string): void;
  /** Get current correlation ID */
  getCorrelationId(): string | undefined;
  /** Generate new correlation ID */
  generateCorrelationId(): string;

  /** Start a timed operation */
  startOperation(name: string, meta?: LogMeta): OperationTimer;
  /** Log HTTP request */
  http(message: string, meta: HttpMeta & LogMeta): void;

  /** Flush pending logs */
  flush(): Promise<void>;
  /** Get current log level */
  getLevel(): LogLevel;
  /** Set log level */
  setLevel(level: LogLevel): void;
}

/**
 * Operation timer for measuring operation duration
 */
export interface OperationTimer {
  /** Operation name */
  name: string;
  /** Start time */
  startTime: number;
  /** End the operation and log result */
  end(success?: boolean, meta?: LogMeta): void;
  /** End with error */
  error(error: Error | string, meta?: LogMeta): void;
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Log handler function type
 */
export type LogHandler = (entry: LogEntry) => void;

/**
 * Log filter function type
 */
export type LogFilter = (entry: LogEntry) => boolean;

/**
 * Log transformer function type
 */
export type LogTransformer = (entry: LogEntry) => LogEntry;
