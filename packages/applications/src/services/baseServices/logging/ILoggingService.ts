/**
 * Interface for the logging service with pluggable transport support
 *
 * This interface defines the contract for logging throughout the application.
 * It supports structured logging with trace context, user context, and
 * arbitrary metadata.
 */

import type { LogLevel } from './transports/types';

/**
 * Structured log metadata
 */
export interface LogMeta {
    /** OpenTelemetry trace ID */
    traceId?: string;

    /** OpenTelemetry span ID */
    spanId?: string;

    /** Request ID for request correlation */
    requestId?: string;

    /** User ID for user-scoped logging */
    userId?: string;

    /** Tenant ID for multi-tenant logging */
    tenantId?: string;

    /** Error object for error logging */
    error?: Error | Record<string, unknown>;

    /** Additional arbitrary metadata */
    [key: string]: unknown;
}

/**
 * Interface for the logging service with file and console transports
 */
export interface ILoggingService {
    /**
     * Log a fatal message (system is unusable)
     * @param message - The fatal message
     * @param meta - Optional metadata or context string
     * @param context - Optional context string (usually class name)
     */
    fatal(message: string, meta?: LogMeta | string, context?: string): void;

    /**
     * Log an error message
     * @param message - The error message
     * @param meta - Optional metadata, error object, or context string
     * @param context - Optional context string (usually class name)
     */
    error(message: string, meta?: LogMeta | Error | string, context?: string): void;

    /**
     * Log a warning message
     * @param message - The warning message
     * @param meta - Optional metadata or context string
     * @param context - Optional context string (usually class name)
     */
    warn(message: string, meta?: LogMeta | string, context?: string): void;

    /**
     * Log an info message
     * @param message - The info message
     * @param meta - Optional metadata or context string
     * @param context - Optional context string (usually class name)
     */
    info(message: string, meta?: LogMeta | string, context?: string): void;

    /**
     * Log a debug message
     * @param message - The debug message
     * @param meta - Optional metadata or context string
     * @param context - Optional context string (usually class name)
     */
    debug(message: string, meta?: LogMeta | string, context?: string): void;

    /**
     * Log a verbose/trace message
     * @param message - The verbose message
     * @param meta - Optional metadata or context string
     * @param context - Optional context string (usually class name)
     */
    verbose(message: string, meta?: LogMeta | string, context?: string): void;

    /**
     * Log an HTTP request/response
     * @param message - The HTTP message
     * @param meta - Additional HTTP metadata
     * @param context - Optional context string
     */
    http(message: string, meta?: LogMeta, context?: string): void;

    /**
     * Log with explicit level
     * @param level - The log level
     * @param message - The log message
     * @param meta - Optional metadata
     * @param context - Optional context string
     */
    logWithLevel(level: LogLevel, message: string, meta?: LogMeta, context?: string): void;

    /**
     * Set the global context for all subsequent logs
     * @param context - The context to set
     */
    setContext(context: string): void;

    /**
     * Create a child logger with a specific context
     * @param context - The context for the child logger
     */
    child(context: string): ILoggingService;

    /**
     * Create a child logger with additional default metadata
     * @param meta - Default metadata for the child logger
     */
    withMeta(meta: LogMeta): ILoggingService;

    /**
     * Flush any pending logs (useful for graceful shutdown)
     */
    flush(): Promise<void>;

    /**
     * Get current log level
     */
    getLevel(): LogLevel;

    /**
     * Set log level dynamically
     */
    setLevel(level: LogLevel): void;
}

export const ILoggingService = Symbol('ILoggingService');
