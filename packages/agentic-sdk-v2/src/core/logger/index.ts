/**
 * @arcaai/vox - Logger Module
 *
 * Comprehensive logging system with support for:
 * - Highlight.io (error tracking and session replay)
 * - Grafana Stack (Loki for logs, Tempo for traces)
 * - OpenTelemetry (OTLP export with trace correlation)
 *
 * Features:
 * - Structured logging with rich metadata
 * - Correlation ID tracking across operations
 * - Automatic trace context propagation
 * - Child loggers with inherited context
 * - Operation timing utilities
 * - Graceful shutdown with log flushing
 *
 * @example
 * ```typescript
 * import { createSDKLogger, type LoggerConfig } from '@arcaai/vox';
 *
 * const logger = createSDKLogger({
 *   level: 'debug',
 *   serviceName: 'my-app',
 *   highlight: {
 *     enabled: true,
 *     projectId: 'YOUR_PROJECT_ID',
 *   },
 *   otel: {
 *     enabled: true,
 *     endpoint: 'https://otel-collector.example.com',
 *   },
 * });
 *
 * // Basic logging
 * logger.info('User logged in', { userId: '123', tenantId: 'tenant-1' });
 *
 * // Timed operation
 * const timer = logger.startOperation('fetchData');
 * try {
 *   await fetchData();
 *   timer.end(true);
 * } catch (error) {
 *   timer.error(error);
 * }
 *
 * // Child logger with context
 * const authLogger = logger.child('AuthService');
 * authLogger.debug('Validating token');
 * ```
 */

// Core logger
export { SDKLogger, createSDKLogger, getGlobalLogger, setGlobalLogger } from './SDKLogger';

// Browser-wide capture (console.*, uncaught errors, unhandled rejections)
export { installGlobalCapture } from './globalCapture';
export type { GlobalCaptureOptions, UninstallGlobalCapture } from './globalCapture';

// Deployment environment resolution (shared by the fail-closed transports)
export { isProductionEnvironment } from './environment';

// Types
export type {
  // Log levels and entries
  LogLevel,
  LogEntry,
  LogMeta,
  // Context types
  TraceContext,
  CorrelationContext,
  UserContext,
  OperationContext,
  ErrorContext,
  HttpMeta,
  SDKMeta,
  ResourceInfo,
  // Configuration types
  LoggerConfig,
  ConsoleTransportConfig,
  HighlightTransportConfig,
  ClarityTransportConfig,
  LokiTransportConfig,
  OTelTransportConfig,
  ILogTransport,
  // Interface types
  ISDKLogger,
  OperationTimer,
  LogHandler,
  LogFilter,
  LogTransformer,
} from './types';

// Constants
export { LOG_LEVEL_VALUES } from './types';

// Utilities
export {
  generateId,
  generateTraceId,
  generateSpanId,
  serializeError,
  safeStringify,
  truncate,
  formatDuration,
  formatBytes,
  getTimestamp,
  getTimestampMs,
  maskSensitiveData,
  isBrowser,
  isNode,
  getEnvironmentInfo,
  extractTraceContext,
  createTraceparent,
} from './utils';

// Transports
export { ConsoleTransport } from './transports/console.transport';
export { HighlightTransport } from './transports/highlight.transport';
export { ClarityTransport } from './transports/clarity.transport';
export { LokiTransport } from './transports/loki.transport';
export { OTelTransport } from './transports/otel.transport';
