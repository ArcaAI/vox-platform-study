/**
 * @arcaai/vox - Logger Utilities
 *
 * Utility functions for logging including:
 * - ID generation for correlation and trace IDs
 * - Error serialization
 * - Safe JSON stringification
 * - Log formatting helpers
 */

/**
 * Generate a random ID (UUID v4 style)
 */
export function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Generate a trace ID (32 hex characters for OpenTelemetry)
 */
export function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buffer = new Uint8Array(16);
    crypto.getRandomValues(buffer);
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Generate a span ID (16 hex characters for OpenTelemetry)
 */
export function generateSpanId(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buffer = new Uint8Array(8);
    crypto.getRandomValues(buffer);
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Serialize an error to a plain object
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    // Capture additional enumerable properties
    for (const key of Object.keys(error)) {
      if (!(key in serialized)) {
        serialized[key] = (error as unknown as Record<string, unknown>)[key];
      }
    }

    // Handle cause chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Error-like objects may have cause.
    if ((error as any).cause) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same reason as the `.cause` check above: Error-like objects may have a non-standard `cause`
      serialized.cause = serializeError((error as any).cause);
    }

    return serialized;
  }

  if (typeof error === 'object' && error !== null) {
    return error as Record<string, unknown>;
  }

  return { message: String(error) };
}

/**
 * Safely stringify JSON with circular reference handling
 */
export function safeStringify(obj: unknown, space?: number): string {
  const seen = new WeakSet();

  return JSON.stringify(
    obj,
    (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }

      // Handle special types
      if (value instanceof Error) {
        return serializeError(value);
      }

      if (typeof value === 'bigint') {
        return value.toString();
      }

      if (typeof value === 'function') {
        return `[Function: ${value.name || 'anonymous'}]`;
      }

      if (typeof value === 'symbol') {
        return value.toString();
      }

      if (value instanceof Map) {
        return Object.fromEntries(value);
      }

      if (value instanceof Set) {
        return Array.from(value);
      }

      if (value instanceof Date) {
        return value.toISOString();
      }

      if (ArrayBuffer.isView(value)) {
        return `[${value.constructor.name}]`;
      }

      return value;
    },
    space,
  );
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(2)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60000).toFixed(2)}m`;
}

/**
 * Format byte size in human-readable format
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Get current timestamp in ISO format
 */
export function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Get current timestamp in milliseconds
 */
export function getTimestampMs(): number {
  return Date.now();
}

/**
 * Mask sensitive data in a string
 */
export function maskSensitiveData(value: string, visibleChars = 4): string {
  if (value.length <= visibleChars * 2) {
    return '*'.repeat(value.length);
  }
  return value.slice(0, visibleChars) + '*'.repeat(value.length - visibleChars * 2) + value.slice(-visibleChars);
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (obj instanceof Date) {
    return new Date(obj.getTime()) as T;
  }

  if (obj instanceof Array) {
    return obj.map((item) => deepClone(item)) as T;
  }

  if (obj instanceof Map) {
    return new Map(Array.from(obj.entries()).map(([k, v]) => [deepClone(k), deepClone(v)])) as T;
  }

  if (obj instanceof Set) {
    return new Set(Array.from(obj).map((item) => deepClone(item))) as T;
  }

  const cloned = {} as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
  }
  return cloned as T;
}

/**
 * Merge objects deeply
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, ...sources: Partial<T>[]): T {
  const result = { ...target };

  for (const source of sources) {
    if (!source) continue;

    for (const key of Object.keys(source) as (keyof T)[]) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (
        typeof sourceValue === 'object' &&
        sourceValue !== null &&
        typeof targetValue === 'object' &&
        targetValue !== null &&
        !Array.isArray(sourceValue) &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>) as T[keyof T];
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue as T[keyof T];
      }
    }
  }

  return result;
}

/**
 * Check if running in browser environment
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof document !== 'undefined';
}

/**
 * Check if running in Node.js environment
 */
export function isNode(): boolean {
  return typeof process !== 'undefined' && process.versions != null && process.versions.node != null;
}

/**
 * Get browser/environment info
 */
export function getEnvironmentInfo(): Record<string, string> {
  const info: Record<string, string> = {};

  if (isBrowser()) {
    info.userAgent = navigator.userAgent;
    info.platform = navigator.platform;
    info.language = navigator.language;
    info.url = window.location.href;
    info.origin = window.location.origin;
  }

  if (isNode()) {
    info.nodeVersion = process.version;
    info.platform = process.platform;
    info.arch = process.arch;
  }

  return info;
}

/**
 * Extract W3C trace context from headers
 * @see https://www.w3.org/TR/trace-context/
 */
export function extractTraceContext(
  headers: Record<string, string | undefined>,
): { traceId?: string; spanId?: string; traceFlags?: number } | undefined {
  const traceparent = headers['traceparent'] || headers['Traceparent'];
  if (!traceparent) return undefined;

  // Format: version-traceId-spanId-traceFlags
  // Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
  const parts = traceparent.split('-');
  if (parts.length !== 4) return undefined;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- W3C traceparent version segment ignored.
  const [_version, traceId, spanId, flagsHex] = parts;

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flagsHex, 16),
  };
}

/**
 * Create W3C traceparent header value
 */
export function createTraceparent(traceId: string, spanId: string, traceFlags = 1): string {
  return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;
}

/** A W3C trace id: exactly 32 lowercase hex characters, not all zero. */
const W3C_TRACE_ID = /^[0-9a-f]{32}$/;

/**
 * Derive a VALID W3C trace id from an arbitrary correlation id.
 *
 * `AgenticClient` used to build the trace id inline as
 * `correlationId.replace(/-/g, '').slice(0, 32).padStart(32, '0')`. That works
 * for the default correlation id — `crypto.randomUUID()`, pure hex plus dashes
 * — but `SDKLogger.setCorrelationId()` is public API, and a host app that
 * threads its own request id through it (`'req-9f3a'`, `'order_12'`, an opaque
 * token) produced a trace id containing non-hex characters.
 *
 * A W3C propagator REJECTS such a `traceparent`: the server silently starts a
 * fresh trace, and the browser hop disappears from every trace with no error
 * anywhere. That is the same silent-severing failure the rest of addresses, one hop further upstream.
 *
 *
 * So: derive from the correlation id when that yields a valid id (keeping the
 * useful property that one browser session's calls share a trace), otherwise
 * generate a fresh valid one. Nothing is lost by the fallback — the client
 * already sends the raw correlation id as `X-Correlation-ID`, and an id the
 * server rejects was never correlating anything.
 */
export function toW3CTraceId(correlationId: string | undefined): string {
  const candidate = (correlationId ?? '').replace(/-/g, '').toLowerCase();
  if (W3C_TRACE_ID.test(candidate) && !/^0+$/.test(candidate)) {
    return candidate;
  }
  return generateTraceId();
}
