/**
 * Logging transports module
 *
 * This module exports all available log transports and their factory functions.
 */

// Types
export * from './types';

// Base transport
export { BaseTransport } from './base.transport';

// Transport implementations
export { ConsoleTransport, createConsoleTransport } from './console.transport';
export { FileTransport, createFileTransport } from './file.transport';
export { HighlightTransport, createHighlightTransport } from './highlight.transport';
export { LokiTransport, createLokiTransport } from './loki.transport';
export { OTelTransport, createOTelTransport } from './otel.transport';
export { OTelLogBridgeTransport, createOTelLogBridgeTransport } from './otel-log-bridge.transport';

// Re-export types for convenience
export type {
  LogLevel,
  LogEntry,
  TransportState,
  BaseTransportConfig,
  ConsoleTransportConfig,
  FileTransportConfig,
  HighlightTransportConfig,
  LokiTransportConfig,
  OTelTransportConfig,
  OTelLogBridgeTransportConfig,
  TransportConfig,
  ILogTransport,
  TransportFactory,
  LoggingConfig,
} from './types';
