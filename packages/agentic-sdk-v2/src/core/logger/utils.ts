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
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
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
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
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
    if ((error as any).cause) {
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
    space
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
export function maskSensitiveData(
  value: string,
  visibleChars = 4
): string {
  if (value.length <= visibleChars * 2) {
    return '*'.repeat(value.length);
  }
  return (
    value.slice(0, visibleChars) +
    '*'.repeat(value.length - visibleChars * 2) +
    value.slice(-visibleChars)
  );
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
    return new Map(
      Array.from(obj.entries()).map(([k, v]) => [deepClone(k), deepClone(v)])
    ) as T;
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
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Partial<T>[]
): T {
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
        result[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        ) as T[keyof T];
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
  return (
    typeof process !== 'undefined' &&
    process.versions != null &&
    process.versions.node != null
  );
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
  headers: Record<string, string | undefined>
): { traceId?: string; spanId?: string; traceFlags?: number } | undefined {
  const traceparent = headers['traceparent'] || headers['Traceparent'];
  if (!traceparent) return undefined;

  // Format: version-traceId-spanId-traceFlags
  // Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
  const parts = traceparent.split('-');
  if (parts.length !== 4) return undefined;

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
export function createTraceparent(
  traceId: string,
  spanId: string,
  traceFlags = 1
): string {
  return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;
}
