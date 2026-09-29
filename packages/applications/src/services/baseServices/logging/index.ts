/**
 * Logging module exports
 *
 * This module provides a pluggable logging system with support for multiple
 * observability backends including:
 * - Console (development and production)
 * - File (rotating log files)
 * - Highlight.io (error tracking and monitoring)
 * - Grafana Loki (log aggregation)
 * - OpenTelemetry (OTLP export for any compatible backend)
 */

// Core interfaces and service
export * from './ILoggingService';
export * from './logging.service';
export * from './logging.module';

// Transports
export * from './transports';

// PHI-safe identifier token (parity with Python `hope_obs.phi.redact_id`)
export { redactId } from './redact-id';

// Utilities
export * from './env.utils';

// Re-export the module with both names for compatibility
export { LoggingServiceModule as LoggingServiceModule } from './logging.module';
