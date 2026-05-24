/**
 * @arcaai/vox - AgenticClient
 *
 * Unified HTTP client for backend communication with comprehensive logging.
 */

import type { ApiConfig } from '../types';
import { AgenticError } from '../types';
import { DEFAULT_TIMEOUT } from './constants';
import type { ISDKLogger } from './logger';
import { createTraceparent, generateSpanId } from './logger';
import { classifyHttpError } from '../utils/errorUtils';

/**
 * Module-level WeakMap holding the admin JWT during impersonation.
 *
 * TASK-264 W0-3: keeping the token outside any AgenticClient instance field
 * (and outside the Zustand store) guarantees it cannot leak via:
 *   - `Object.keys(client)` / `Object.getOwnPropertyNames(client)`
 *   - `JSON.stringify(client)` (no enumerable property exists)
 *   - DevTools "expand object" view (the WeakMap entry is not shown on the
 *     instance)
 *   - Structured-clone messages over `BroadcastChannel` / `postMessage`
 *   - Zustand store snapshots, persisted storage, Highlight session replays
 *
 * The token is removed when `stopImpersonation()` is called, when the client
 * is garbage-collected (WeakMap semantics), or when `clearImpersonation()`
 * (test hook) is invoked.
 */
const impersonationTokens = new WeakMap<AgenticClient, string>();

/**
 * HTTP client for ARCAAI API communication.
 */
export class AgenticClient {
  private baseUrl: string;
  private accessToken?: string;
  private apiKey?: string;
  private tenantId?: string;
  private timeout: number;
  private logger?: ISDKLogger;
  private requestCount = 0;

  private rateLimitConfig?: { maxRequests: number; windowMs: number };
  private requestTimestamps: number[] = [];
  /**
   * TASK-297 L-1 (transports) — hard cap on `requestTimestamps` so a long-
   * running tab that never trips the rate limit cannot grow this array
   * unbounded. We keep at most this many recent timestamps; the rate
   * limiter still filters by window for correctness.
   */
  private static readonly MAX_REQUEST_TIMESTAMPS = 1024;
  private onUnauthorizedHandler?: () => Promise<boolean>;
  private inflightRefresh: Promise<boolean> | null = null;

  constructor(config: ApiConfig, logger?: ISDKLogger) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.accessToken = config.accessToken;
    this.apiKey = config.apiKey;
    this.tenantId = config.tenantId;
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.logger = logger;
    this.rateLimitConfig = config.rateLimit;

    this.logger?.debug('AgenticClient initialized', {
      operation: 'constructor',
      component: 'AgenticClient',
      attributes: {
        baseUrl: this.baseUrl,
        hasTenantId: !!this.tenantId,
        timeout: this.timeout,
      },
    });
  }

  private checkRateLimit(): void {
    if (!this.rateLimitConfig) return;

    const now = Date.now();
    const { maxRequests, windowMs } = this.rateLimitConfig;

    this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < windowMs);

    // TASK-297 L-1 (transports) — also bound the array size so even an
    // adversarial / mis-configured window can't grow it unbounded.
    if (this.requestTimestamps.length > AgenticClient.MAX_REQUEST_TIMESTAMPS) {
      this.requestTimestamps = this.requestTimestamps.slice(-AgenticClient.MAX_REQUEST_TIMESTAMPS);
    }

    if (this.requestTimestamps.length >= maxRequests) {
      throw new AgenticError('RATE_LIMITED', 'Client-side rate limit exceeded', {
        context: { maxRequests, windowMs, currentCount: this.requestTimestamps.length },
      });
    }

    this.requestTimestamps.push(now);
  }

  /**
   * TASK-297 H-6 (transports) — endpoints whose 401 must NOT trigger an
   * automatic refresh. These either ARE the auth flow (login, refresh,
   * stream-ticket, impersonate) or would loop forever if we retried.
   */
  private static readonly REFRESH_SKIP_ENDPOINTS: readonly string[] = ['/auth/refresh', '/auth/login', '/auth/stream-ticket', '/auth/impersonate'];

  private static shouldSkipRefresh(endpoint: string): boolean {
    return AgenticClient.REFRESH_SKIP_ENDPOINTS.some((skip) => endpoint.includes(skip));
  }

  private static validateBody(body: unknown): void {
    if (body === undefined || body === null) return;
    if (typeof body === 'function' || typeof body === 'symbol') {
      throw new AgenticError('VALIDATION_ERROR', `Request body cannot be a ${typeof body}`);
    }
  }

  private static readonly AUTH_REFRESH_ENDPOINT = '/auth/refresh';

  /**
   * Make an HTTP request with comprehensive logging
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options?: RequestInit,
    externalSignal?: AbortSignal,
    isRetry = false,
  ): Promise<T> {
    this.checkRateLimit();
    AgenticClient.validateBody(body);

    const requestId = `req_${++this.requestCount}_${Date.now()}`;
    const spanId = generateSpanId();
    const startTime = performance.now();
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    // Build headers with trace context
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
      ...((options?.headers as Record<string, string>) || {}),
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (this.tenantId) {
      headers['X-Tenant-ID'] = this.tenantId;
    }

    // Add trace context for distributed tracing
    const correlationId = this.logger?.getCorrelationId();
    if (correlationId) {
      headers['X-Correlation-ID'] = correlationId;
      // Add W3C traceparent header for OpenTelemetry compatibility
      const traceId = correlationId.replace(/-/g, '').slice(0, 32).padStart(32, '0');
      headers['traceparent'] = createTraceparent(traceId, spanId);
    }

    let serializedBody: string | undefined;
    if (body !== undefined && body !== null) {
      try {
        serializedBody = JSON.stringify(body);
      } catch (err) {
        clearTimeout(timeoutId);
        throw new AgenticError('VALIDATION_ERROR', 'Request body is not JSON-serializable', {
          cause: err as Error,
          context: { endpoint, method },
        });
      }
    }

    // Log request start
    this.logger?.debug(`HTTP ${method} ${endpoint}`, {
      operation: 'httpRequest',
      component: 'AgenticClient',
      requestId,
      http: {
        method,
        url: endpoint,
        requestSize: serializedBody?.length ?? 0,
      },
      attributes: {
        fullUrl: url,
        hasBody: !!body,
        spanId,
      },
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Strip fetch overrides; method/headers/body/signal come from outer scope.
      const { signal: _s, headers: _h, body: _b, method: _m, ...safeOptions } = options ?? {};
      const response = await fetch(url, {
        method,
        headers,
        body: serializedBody,
        signal: controller.signal,
        ...safeOptions,
      });

      clearTimeout(timeoutId);
      const durationMs = Math.round(performance.now() - startTime);

      // Log response
      this.logger?.http(`HTTP ${method} ${endpoint} ${response.status}`, {
        operation: 'httpResponse',
        component: 'AgenticClient',
        requestId,
        durationMs,
        success: response.ok,
        http: {
          method,
          url: endpoint,
          statusCode: response.status,
          responseTimeMs: durationMs,
        },
        attributes: {
          spanId,
          contentType: response.headers.get('content-type'),
        },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorCode = classifyHttpError(response.status);
        const errorMessage = errorData.message || `HTTP ${response.status}: ${response.statusText}`;

        this.logger?.error(`API request failed: ${errorMessage}`, {
          operation: 'httpRequest',
          component: 'AgenticClient',
          requestId,
          durationMs,
          success: false,
          http: {
            method,
            url: endpoint,
            statusCode: response.status,
            responseTimeMs: durationMs,
          },
          error: {
            code: errorCode,
            name: 'AgenticError',
            httpStatus: response.status,
            endpoint,
          },
          attributes: {
            spanId,
            errorData,
          },
        });

        // TASK-297 H-6 (transports) — broaden the 401 skip-list so we don't
        // attempt a refresh for endpoints that ARE part of the auth flow.
        if (response.status === 401 && !isRetry && this.onUnauthorizedHandler && !AgenticClient.shouldSkipRefresh(endpoint)) {
          try {
            const refreshed = await this.deduplicatedRefresh();
            if (refreshed) {
              return this.request<T>(method, endpoint, body, options, externalSignal, true);
            }
          } catch {
            // Refresh failed — fall through to throw the original 401
          }
        }

        throw new AgenticError(errorCode, errorMessage, { context: { status: response.status, endpoint, requestId } });
      }

      // Handle 204 No Content
      if (response.status === 204) {
        return undefined as T;
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      const durationMs = Math.round(performance.now() - startTime);

      if (error instanceof AgenticError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        this.logger?.error('Request timeout', {
          operation: 'httpRequest',
          component: 'AgenticClient',
          requestId,
          durationMs,
          success: false,
          http: {
            method,
            url: endpoint,
            responseTimeMs: durationMs,
          },
          error: {
            code: 'NETWORK_ERROR',
            name: 'TimeoutError',
            endpoint,
          },
          attributes: {
            spanId,
            timeout: this.timeout,
          },
        });

        throw new AgenticError('NETWORK_ERROR', 'Request timeout', {
          cause: error,
          context: { timeout: this.timeout, endpoint, requestId },
        });
      }

      if (error instanceof TypeError) {
        this.logger?.error('Network error', {
          operation: 'httpRequest',
          component: 'AgenticClient',
          requestId,
          durationMs,
          success: false,
          http: {
            method,
            url: endpoint,
            responseTimeMs: durationMs,
          },
          error: {
            code: 'NETWORK_ERROR',
            name: 'NetworkError',
            endpoint,
          },
          attributes: {
            spanId,
            errorMessage: error.message,
          },
        });

        throw new AgenticError('NETWORK_ERROR', 'Network error - check your connection', {
          cause: error as Error,
          context: { endpoint, requestId },
        });
      }

      this.logger?.error('Unexpected error during HTTP request', {
        operation: 'httpRequest',
        component: 'AgenticClient',
        requestId,
        durationMs,
        success: false,
        http: {
          method,
          url: endpoint,
          responseTimeMs: durationMs,
        },
        error: error as Error,
        attributes: {
          spanId,
        },
      });

      throw new AgenticError('UNKNOWN_ERROR', 'An unexpected error occurred', {
        cause: error as Error,
        context: { endpoint, requestId },
      });
    }
  }

  /**
   * GET request
   */
  async get<T>(endpoint: string, options?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>('GET', endpoint, undefined, undefined, options?.signal);
  }

  /**
   * POST request
   */
  async post<T>(endpoint: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>('POST', endpoint, body, undefined, options?.signal);
  }

  /**
   * PATCH request
   */
  async patch<T>(endpoint: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>('PATCH', endpoint, body, undefined, options?.signal);
  }

  /**
   * PUT request
   */
  async put<T>(endpoint: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>('PUT', endpoint, body, undefined, options?.signal);
  }

  /**
   * DELETE request
   */
  async delete<T>(endpoint: string, options?: { signal?: AbortSignal }): Promise<T> {
    return this.request<T>('DELETE', endpoint, undefined, undefined, options?.signal);
  }

  /**
   * POST request with FormData body (multipart/form-data).
   * Omits Content-Type header so the browser sets the multipart boundary.
   * Auth headers (X-API-Key, X-Tenant-ID, correlation) are included.
   */
  async postFormData<T>(
    endpoint: string,
    formData: FormData,
    options?: { signal?: AbortSignal },
    // TASK-297 M-7 (transports) — flag used by the auto-retry path so we
    // don't loop forever when the post-refresh response is still 401.
    isRetry = false,
  ): Promise<T> {
    const requestId = `req_${++this.requestCount}_${Date.now()}`;
    const spanId = generateSpanId();
    const startTime = performance.now();
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    const headers: Record<string, string> = {
      'X-Request-ID': requestId,
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (this.tenantId) {
      headers['X-Tenant-ID'] = this.tenantId;
    }

    const correlationId = this.logger?.getCorrelationId();
    if (correlationId) {
      headers['X-Correlation-ID'] = correlationId;
      const traceId = correlationId.replace(/-/g, '').slice(0, 32).padStart(32, '0');
      headers['traceparent'] = createTraceparent(traceId, spanId);
    }

    this.logger?.debug(`HTTP POST (FormData) ${endpoint}`, {
      operation: 'httpRequest',
      component: 'AgenticClient',
      requestId,
      http: { method: 'POST', url: endpoint },
      attributes: { fullUrl: url, spanId },
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const durationMs = Math.round(performance.now() - startTime);

      this.logger?.http(`HTTP POST ${endpoint} ${response.status}`, {
        operation: 'httpResponse',
        component: 'AgenticClient',
        requestId,
        durationMs,
        success: response.ok,
        http: { method: 'POST', url: endpoint, statusCode: response.status, responseTimeMs: durationMs },
        attributes: { spanId },
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorCode = classifyHttpError(response.status);
        const errorMessage = errorData.message || `HTTP ${response.status}: ${response.statusText}`;

        // TASK-297 M-7 (transports) — postFormData now respects the same
        // 401-refresh contract as `request()`, so multipart uploads (voice
        // enrollment etc.) don't fail outright on transient token expiry.
        if (response.status === 401 && !isRetry && this.onUnauthorizedHandler && !AgenticClient.shouldSkipRefresh(endpoint)) {
          try {
            const refreshed = await this.deduplicatedRefresh();
            if (refreshed) {
              return this.postFormData<T>(endpoint, formData, options, true);
            }
          } catch {
            // Fall through to throw the original 401.
          }
        }

        throw new AgenticError(errorCode, errorMessage, {
          context: { status: response.status, endpoint, requestId },
        });
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof AgenticError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new AgenticError('NETWORK_ERROR', 'Request timeout', {
          cause: error,
          context: { timeout: this.timeout, endpoint, requestId },
        });
      }

      if (error instanceof TypeError) {
        throw new AgenticError('NETWORK_ERROR', 'Network error - check your connection', {
          cause: error,
          context: { endpoint, requestId },
        });
      }

      throw new AgenticError('UNKNOWN_ERROR', 'An unexpected error occurred', {
        cause: error as Error,
        context: { endpoint, requestId },
      });
    }
  }

  /**
   * Upload FormData using XMLHttpRequest for upload progress reporting.
   * Supports AbortSignal for cancellation and reports progress via onProgress callback.
   */
  uploadFormData<T>(
    endpoint: string,
    formData: FormData,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: number) => void;
      /**
       * Request timeout in milliseconds. Pass `0` to disable the timeout entirely (recommended
       * for long-running uploads like large audio files, where `signal` + progress events
       * are used instead). Defaults to the client-wide timeout.
       */
      timeout?: number;
    },
  ): Promise<T> {
    this.checkRateLimit();

    const requestId = `req_${++this.requestCount}_${Date.now()}`;
    const spanId = generateSpanId();
    const startTime = performance.now();
    const url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      'X-Request-ID': requestId,
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    if (this.tenantId) {
      headers['X-Tenant-ID'] = this.tenantId;
    }

    const correlationId = this.logger?.getCorrelationId();
    if (correlationId) {
      headers['X-Correlation-ID'] = correlationId;
      const traceId = correlationId.replace(/-/g, '').slice(0, 32).padStart(32, '0');
      headers['traceparent'] = createTraceparent(traceId, spanId);
    }

    this.logger?.debug(`HTTP POST (FormData/XHR) ${endpoint}`, {
      operation: 'httpRequest',
      component: 'AgenticClient',
      requestId,
      http: { method: 'POST', url: endpoint },
      attributes: { fullUrl: url, spanId },
    });

    return new Promise<T>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);

      for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
      }

      const effectiveTimeout = options?.timeout ?? this.timeout;
      // XHR treats `timeout === 0` as "no timeout", which we want for arbitrary-size uploads.
      xhr.timeout = effectiveTimeout;

      if (options?.signal) {
        if (options.signal.aborted) {
          reject(
            new AgenticError('NETWORK_ERROR', 'Request aborted', {
              context: { endpoint, requestId },
            }),
          );
          return;
        }
        options.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }

      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (event.lengthComputable && options?.onProgress) {
          const progress = Math.round((event.loaded / event.total) * 100);
          options.onProgress(progress);
        }
      };

      xhr.onload = () => {
        const durationMs = Math.round(performance.now() - startTime);

        this.logger?.http(`HTTP POST ${endpoint} ${xhr.status}`, {
          operation: 'httpResponse',
          component: 'AgenticClient',
          requestId,
          durationMs,
          success: xhr.status >= 200 && xhr.status < 300,
          http: { method: 'POST', url: endpoint, statusCode: xhr.status, responseTimeMs: durationMs },
          attributes: { spanId },
        });

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as T);
          } catch {
            resolve(undefined as T);
          }
        } else {
          let errorData: Record<string, unknown> = {};
          try {
            errorData = JSON.parse(xhr.responseText);
          } catch {
            // ignore parse errors
          }
          const errorCode = classifyHttpError(xhr.status);
          const errorMessage = (errorData.message as string) || `HTTP ${xhr.status}: ${xhr.statusText}`;
          reject(
            new AgenticError(errorCode, errorMessage, {
              context: { status: xhr.status, endpoint, requestId },
            }),
          );
        }
      };

      xhr.onerror = () => {
        reject(
          new AgenticError('NETWORK_ERROR', 'Network error - check your connection', {
            context: { endpoint, requestId },
          }),
        );
      };

      xhr.ontimeout = () => {
        reject(
          new AgenticError('NETWORK_ERROR', 'Request timeout', {
            context: { timeout: effectiveTimeout, endpoint, requestId },
          }),
        );
      };

      xhr.onabort = () => {
        reject(
          new AgenticError('NETWORK_ERROR', 'Request aborted', {
            context: { endpoint, requestId },
          }),
        );
      };

      xhr.send(formData);
    });
  }

  /**
   * Get the base URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  getAccessToken(): string | undefined {
    return this.accessToken;
  }

  updateAccessToken(token: string): void {
    this.logger?.info('Access token updated', {
      operation: 'updateAccessToken',
      component: 'AgenticClient',
    });
    this.accessToken = token;
  }

  clearAccessToken(): void {
    this.logger?.info('Access token cleared', {
      operation: 'clearAccessToken',
      component: 'AgenticClient',
    });
    this.accessToken = undefined;
  }

  getApiKey(): string | undefined {
    return this.apiKey;
  }

  updateApiKey(apiKey: string): void {
    this.logger?.info('API key updated', {
      operation: 'updateApiKey',
      component: 'AgenticClient',
    });
    this.apiKey = apiKey;
  }

  clearApiKey(): void {
    this.logger?.info('API key cleared', {
      operation: 'clearApiKey',
      component: 'AgenticClient',
    });
    this.apiKey = undefined;
  }

  getTenantId(): string | undefined {
    return this.tenantId;
  }

  updateTenantId(tenantId: string): void {
    this.logger?.info('Tenant ID updated', {
      operation: 'updateTenantId',
      component: 'AgenticClient',
    });
    this.tenantId = tenantId;
  }

  clearTenantId(): void {
    this.logger?.info('Tenant ID cleared', {
      operation: 'clearTenantId',
      component: 'AgenticClient',
    });
    this.tenantId = undefined;
  }

  private async deduplicatedRefresh(): Promise<boolean> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    this.inflightRefresh = this.onUnauthorizedHandler!();
    try {
      return await this.inflightRefresh;
    } finally {
      this.inflightRefresh = null;
    }
  }

  /**
   * Register a callback invoked when a 401 Unauthorized response is received.
   * The callback should attempt to refresh the access token and return `true`
   * if the token was refreshed successfully (the original request will be retried),
   * or `false` to propagate the 401 error.
   */
  setOnUnauthorized(handler: () => Promise<boolean>): void {
    this.onUnauthorizedHandler = handler;
  }

  // =========================================================================
  // Impersonation (TASK-264 W0-3)
  //
  // The admin's original JWT lives in a module-level WeakMap keyed by `this`.
  // It is NOT a field on the instance so it cannot leak via Object.keys,
  // JSON.stringify, Zustand snapshots, or BroadcastChannel structured clone.
  // =========================================================================

  /**
   * Begin an impersonation session by stashing the caller's current admin
   * JWT in a non-enumerable, non-serializable store. Must be paired with
   * `stopImpersonation()` to restore the original token.
   *
   * After calling this, `updateAccessToken(impersonatedJwt)` is the caller's
   * responsibility (see `useAuth.impersonate`).
   *
   * @throws if `token` is empty or impersonation is already active.
   */
  startImpersonation(token: string): void {
    if (typeof token !== 'string' || token.length === 0) {
      throw new AgenticError('VALIDATION_ERROR', 'startImpersonation requires a non-empty token', {
        context: { operation: 'startImpersonation' },
      });
    }
    if (impersonationTokens.has(this)) {
      throw new AgenticError('VALIDATION_ERROR', 'Impersonation already active — call stopImpersonation first', {
        context: { operation: 'startImpersonation' },
      });
    }
    impersonationTokens.set(this, token);
    this.logger?.info('Impersonation started', {
      operation: 'startImpersonation',
      component: 'AgenticClient',
    });
  }

  /**
   * End an impersonation session and return the original admin token, which
   * the caller is expected to feed back into `updateAccessToken()`.
   *
   * Returns `undefined` if no impersonation was active. Idempotent — the
   * second call returns `undefined`.
   */
  stopImpersonation(): string | undefined {
    const token = impersonationTokens.get(this);
    impersonationTokens.delete(this);
    if (token !== undefined) {
      this.logger?.info('Impersonation stopped', {
        operation: 'stopImpersonation',
        component: 'AgenticClient',
      });
    }
    return token;
  }

  /**
   * Whether an impersonation session is currently active.
   */
  isImpersonating(): boolean {
    return impersonationTokens.has(this);
  }
}
