/**
 * `fetch` wrapper: builds auth/tenant/content-type/user-agent headers,
 * composes a per-request timeout with an optional caller `AbortSignal`,
 * maps non-2xx responses to the {@link HopeAPIError} hierarchy, and drives
 * {@link executeWithRetry}. `fetch` is always injectable — this module
 * itself never references the network beyond calling whatever `fetch`
 * implementation it was given (defaulting to the global one).
 */

import { APIConnectionError, APITimeoutError, fromResponse } from './errors';
import type { HeaderInput } from './redact';
import { executeWithRetry } from './retry';
import type { QueryValue } from './url';
import { buildUrl } from './url';

/**
 * This package's identity, echoed in the `User-Agent` header as
 * `arcaai/vox-node/<version>`. `SDK_VERSION` is kept in sync with
 * `package.json#version` by hand — this package ships zero runtime
 * dependencies, and reading `package.json` at runtime would mean either a
 * build-config change to the (out-of-scope) `tsup.config.ts`/`tsconfig.json`
 * for a dual ESM/CJS JSON import, or a `require`/`import` divergence between
 * the two output formats. See the report.
 */
const SDK_USER_AGENT_NAME = 'arcaai/vox-node';
const SDK_VERSION = '3.0.0';

/**
 * The default `User-Agent` value. Exported so a test can assert it stays in sync
 * with `package.json#version` — hand-maintained constants drift silently, and a
 * stale version here is only discovered when someone is trying to correlate SDK
 * versions in gateway logs during an incident.
 */
export const SDK_USER_AGENT = `${SDK_USER_AGENT_NAME}/${SDK_VERSION}`;

const DEFAULT_TIMEOUT_MS = 60_000;

/** Construction-time configuration for a {@link Transport} instance. */
export interface TransportConfig {
  /** e.g. `http://localhost:8868`. Joined with each request's `path` via `core/url.ts#buildUrl`. */
  baseUrl: string;
  /** Sent as `X-API-Key` on every request, when set. */
  apiKey?: string;
  /**
   * When set, called on every request to obtain a bearer token, sent as
   * `Authorization: Bearer <token>`. May be async (e.g. a rotating-token
   * provider). A falsy return omits the header for that request.
   */
  getToken?: () => string | undefined | Promise<string | undefined>;
  /** Sent as `X-Tenant-Id` on every request, when set (super-admin API keys only — see `.claude/rules/13-nextjs-apps.md`). */
  tenantId?: string;
  /** Default per-request timeout in ms. Default `60_000`. */
  timeoutMs?: number;
  /** Default `maxRetries` passed to `executeWithRetry`. Default `2` (retry.ts's own default). */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests; defaults to the global `fetch`. Never hit the real network from a unit test. */
  fetch?: typeof fetch;
  /** Overrides the computed `arcaai/vox-node/<version>` User-Agent value. */
  userAgent?: string;
  /** Injectable RNG for `executeWithRetry`'s backoff jitter. Defaults to `Math.random`. */
  random?: () => number;
  /** Injectable sleep for `executeWithRetry`'s backoff wait. Defaults to a real `setTimeout`-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-call request options. */
export interface TransportRequestOptions {
  /** Default `'GET'`. */
  method?: string;
  /** Gateway-relative path, joined via `core/url.ts#buildUrl` (leading slash optional). */
  path: string;
  query?: Record<string, QueryValue>;
  /** JSON-serialized as the request body when present; also sets `Content-Type: application/json`. */
  body?: unknown;
  /** Merged on top of the default headers — set here to override a default (e.g. a streaming request's `Accept`). */
  headers?: HeaderInput;
  /** Composed with the per-request timeout via `AbortSignal.any`. */
  signal?: AbortSignal;
  /** Overrides `TransportConfig.timeoutMs` for this call. */
  timeoutMs?: number;
  /** Overrides `TransportConfig.maxRetries` for this call. */
  maxRetries?: number;
  /**
   * Set when the caller supplied an idempotency key for this request — the
   * ONLY condition under which a non-idempotent `POST` is retried
   * (`core/retry.ts#shouldRetry`). This flag does not itself send anything;
   * HOPE's idempotency key is a BODY field the resources layer includes in
   * `body`, not a header.
   */
  hasIdempotencyKey?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function buildHeaders(config: TransportConfig, options: TransportRequestOptions): Promise<Headers> {
  const headers = new Headers();
  headers.set('User-Agent', config.userAgent ?? SDK_USER_AGENT);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (config.apiKey) headers.set('X-API-Key', config.apiKey);
  if (config.getToken) {
    const token = await config.getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  if (config.tenantId) headers.set('X-Tenant-Id', config.tenantId);
  if (options.headers) {
    const extra = options.headers instanceof Headers ? options.headers : new Headers(options.headers);
    for (const [key, value] of extra.entries()) headers.set(key, value);
  }
  return headers;
}

function composeSignal(timeoutMs: number, callerSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
}

/** Read the response body as JSON, tolerating an empty or non-JSON body (returns `undefined`). */
async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `fetch` wrapper for the HOPE gateway. One instance is constructed with the
 * connection-level config (base URL, credentials, defaults); each call to
 * {@link Transport.request}/{@link Transport.stream} supplies the per-request
 * specifics.
 */
export class Transport {
  private readonly config: TransportConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TransportConfig) {
    this.config = config;
    this.fetchImpl = config.fetch ?? fetch;
  }

  /** Perform one HTTP attempt (no retry) and return the raw `Response`. Throws {@link APIConnectionError}/{@link APITimeoutError} on a connect-phase or timeout failure. */
  private async performAttempt(options: TransportRequestOptions): Promise<Response> {
    const method = options.method ?? 'GET';
    const url = buildUrl(this.config.baseUrl, options.path, { query: options.query });
    const headers = await buildHeaders(this.config, options);
    const signal = composeSignal(options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal);

    const init: RequestInit = { method, headers, signal };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      const name = isRecord(err) && typeof err.name === 'string' ? err.name : undefined;
      if (name === 'TimeoutError') {
        throw new APITimeoutError({ cause: err });
      }
      if (name === 'AbortError' && options.signal?.aborted) {
        // The CALLER's own signal fired — not a connection failure, and not
        // retryable; let the caller's abort reason propagate as-is.
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new APIConnectionError({ message, cause: err });
    }
  }

  private retryOptions(options: TransportRequestOptions) {
    return {
      method: options.method ?? 'GET',
      hasIdempotencyKey: options.hasIdempotencyKey,
      maxRetries: options.maxRetries ?? this.config.maxRetries,
      baseDelayMs: this.config.baseDelayMs,
      maxDelayMs: this.config.maxDelayMs,
      random: this.config.random,
      sleep: this.config.sleep,
    };
  }

  /**
   * Perform a request and return the parsed JSON response body. Throws the
   * matching {@link HopeAPIError} subclass (via `core/errors.ts#fromResponse`)
   * for a non-2xx response, after retrying per `core/retry.ts`.
   */
  async request<T = unknown>(options: TransportRequestOptions): Promise<T> {
    return executeWithRetry(async () => {
      const response = await this.performAttempt(options);
      const body = await parseJsonBody(response);
      if (!response.ok) {
        throw fromResponse(response, body);
      }
      return body as T;
    }, this.retryOptions(options));
  }

  /**
   * Perform a request and return the raw `Response` WITHOUT consuming its
   * body — for SSE endpoints, whose body `core/sse.ts` reads directly. Still
   * applies retry and throws the typed error for a non-2xx response (the
   * body is read once, to build the error, only in that failure path).
   */
  async stream(options: TransportRequestOptions): Promise<Response> {
    return executeWithRetry(async () => {
      const response = await this.performAttempt(options);
      if (!response.ok) {
        const body = await parseJsonBody(response);
        throw fromResponse(response, body);
      }
      return response;
    }, this.retryOptions(options));
  }
}
