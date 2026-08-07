/**
 * Typed error hierarchy mirroring the gateway's real HTTP contracts
 * (`.claude/rules/05-nestjs-api.md`): domain/persistence exceptions map to
 * specific statuses via `ExceptionInterceptor`
 * (`apps/api/src/interceptors/exception.interceptor.ts`), and OCC/quota
 * bodies carry `code` + `metadata`. `fromResponse` performs that mapping on
 * the SDK side so callers can `catch` a specific class instead of switching
 * on `error.status`.
 */

import { redactHeaders } from './redact';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const { message, error } = body;
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message) && message.length > 0) {
    return message.filter((m): m is string => typeof m === 'string').join('; ');
  }
  if (typeof error === 'string' && error.trim()) return error;
  return undefined;
}

function readCode(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return typeof body.code === 'string' ? body.code : undefined;
}

function readCorrelationId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return typeof body.correlationId === 'string' ? body.correlationId : undefined;
}

function readCurrentVersion(body: unknown): number | undefined {
  if (!isRecord(body)) return undefined;
  const metadata = body.metadata;
  if (!isRecord(metadata)) return undefined;
  return typeof metadata.currentVersion === 'number' ? metadata.currentVersion : undefined;
}

/**
 * Parse a `Retry-After` header value (RFC 9110 §10.2.3) into milliseconds.
 * Accepts either form:
 *   - delta-seconds: `"30"` → 30_000
 *   - HTTP-date: `"Wed, 21 Oct 2026 07:28:00 GMT"` → (date - now), clamped to 0
 *
 * Exported so `core/retry.ts` reuses the same parser for its own retry
 * scheduling instead of duplicating the delta-seconds-vs-HTTP-date logic.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Authentication failed.';
    case 403:
      return 'Permission denied.';
    case 404:
      return 'Resource not found.';
    case 409:
      return 'Quota exceeded.';
    case 412:
      return 'Version conflict.';
    case 428:
      return 'Precondition required — missing If-Match header.';
    case 429:
      return 'Rate limited.';
    default:
      return `Request failed with status ${status}.`;
  }
}

/** Constructor options shared by every {@link HopeAPIError} subclass. */
export interface HopeAPIErrorInit {
  status: number;
  message?: string;
  code?: string;
  requestId?: string;
  headers?: Headers;
  cause?: unknown;
}

/**
 * Base class for every error this SDK throws for a non-2xx HOPE gateway
 * response. Carries `status`, `code` (the domain error code from
 * `BaseException.toJSON()` when present, e.g. `PERSISTENCE.CONCURRENCY_CONFLICT`),
 * `requestId` (for support correlation), and the response `headers`.
 *
 * Response/request BODIES are deliberately NOT stored on this class — see
 * `core/redact.ts` — transcripts and summaries are PHI and must never be
 * reachable from an error's `toString()`/`toJSON()`/`util.inspect()` output.
 */
export class HopeAPIError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly headers?: Headers;

  constructor(init: HopeAPIErrorInit) {
    super(init.message ?? defaultMessageForStatus(init.status), {
      cause: init.cause,
    });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    // Redact on the way IN, not just on the way out — a caller who forgot
    // to pre-redact (or a debugging proxy that echoes a request header back
    // on the response) still cannot leak a secret through this error, since
    // nothing but the redacted copy is ever stored. See core/redact.ts.
    this.headers = init.headers ? redactHeaders(init.headers) : undefined;
    // Explicit prototype fix-up: down-level (ES5) transpilation of
    // `class X extends Error` breaks `instanceof` because `Error`'s
    // constructor, when called as `super()`, can return a NEW object bound
    // to `Error.prototype` rather than mutating `this`. That new object's
    // prototype chain doesn't include the subclass unless we reset it here.
    // `new.target.prototype` (not `HopeAPIError.prototype`) is essential so
    // this works for every subclass, including ones that extend a subclass
    // (APITimeoutError extends APIConnectionError).
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A streaming response failed at the protocol level rather than the HTTP level:
 * the gateway emitted an `error` frame mid-stream, or the stream ended without
 * ever producing its terminal `result` frame.
 *
 * Deliberately NOT a {@link HopeAPIError} — by the time this is thrown the HTTP
 * exchange has already succeeded (200 + an open `text/event-stream`), so there
 * is no meaningful status code to carry. Callers distinguish "the request was
 * rejected" (`HopeAPIError`) from "the request was accepted but the stream went
 * wrong" (`HopeStreamError`).
 *
 * The `detail` carried by a gateway `error` frame is already PHI-redacted
 * upstream and never echoes model output — see `smr-compat.controller.ts`.
 */
export class HopeStreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HopeStreamError';
    // Same prototype fix-up rationale as HopeAPIError above.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** HTTP 401 — the API key (or bearer token) was missing, invalid, or expired. */
export class AuthenticationError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    super({ ...init, status: 401 });
  }
}

/** HTTP 403 — a privilege boundary, e.g. a global-admin-only action attempted by a tenant admin. */
export class PermissionError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    super({ ...init, status: 403 });
  }
}

/**
 * HTTP 404.
 *
 * **HOPE's tenancy posture is 404-over-403**: a cross-tenant read or write
 * returns 404, never 403 (`.claude/rules/05-nestjs-api.md` — "Cross-tenant
 * access returns 404, never 403"). This hides resource *existence* from a
 * caller who is not entitled to see it — a resource that exists but belongs
 * to a different tenant is, on the wire, indistinguishable from a resource
 * that never existed.
 *
 * **Practically**: when your integration gets a `NotFoundError`, do not
 * assume the route is wrong or the id was mistyped. It may mean the id is
 * real and correctly formed, but scoped to a tenant your API key cannot
 * access (e.g. the key's bound tenant differs from the consultation's
 * tenant). Verify tenant ownership before treating this as a client bug.
 */
export class NotFoundError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    const serverMessage = init.message?.trim() || defaultMessageForStatus(404);
    const message = `${serverMessage} (HOPE returns 404 for cross-tenant access as well as a missing route — this id may exist but belong to a different tenant; see NotFoundError's docstring for the 404-over-403 posture.)`;
    super({ ...init, status: 404, message });
  }
}

/** HTTP 409 — an entitlements quota (quantity-capped resource) was exceeded. */
export class QuotaExceededError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    super({ ...init, status: 409 });
  }
}

/** Constructor options for {@link VersionConflictError}. */
export interface VersionConflictErrorInit extends Omit<HopeAPIErrorInit, 'status'> {
  /** The server's current `_version` value, when the body carried `metadata.currentVersion`. */
  currentVersion?: number;
}

/**
 * HTTP 412 — optimistic-concurrency (`If-Match`) conflict: the caller's
 * `expectedVersion` no longer matches the row's `_version`. Mirrors
 * `OptimisticConcurrencyException` → `err.toJSON()`'s
 * `metadata.currentVersion` (`apps/api/src/interceptors/exception.interceptor.ts`).
 * Re-fetch the resource, merge, and retry with the fresh version.
 */
export class VersionConflictError extends HopeAPIError {
  readonly currentVersion?: number;

  constructor(init: VersionConflictErrorInit) {
    super({ ...init, status: 412 });
    this.currentVersion = init.currentVersion;
  }
}

/** HTTP 428 — a versioned PATCH route was called without the required `If-Match` header. */
export class PreconditionRequiredError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    super({ ...init, status: 428 });
  }
}

/** Constructor options for {@link RateLimitError}. */
export interface RateLimitErrorInit extends Omit<HopeAPIErrorInit, 'status'> {
  /** Milliseconds to wait before retrying, parsed from the `Retry-After` response header, when present. */
  retryAfterMs?: number;
}

/** HTTP 429 — rate limited by `TieredThrottlerGuard` or an entitlements meter cap. */
export class RateLimitError extends HopeAPIError {
  readonly retryAfterMs?: number;

  constructor(init: RateLimitErrorInit) {
    super({ ...init, status: 429 });
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** Constructor options for {@link APIConnectionError}. */
export interface APIConnectionErrorInit {
  message?: string;
  cause?: unknown;
  requestId?: string;
}

/**
 * No HTTP response was ever received: DNS failure, connection refused, TLS
 * error, or the request was aborted for a reason other than the caller's own
 * `AbortSignal`. `status` is `0` — there is no HTTP status to report.
 */
export class APIConnectionError extends HopeAPIError {
  constructor(init: APIConnectionErrorInit) {
    super({
      status: 0,
      code: 'connection_error',
      message: init.message ?? 'Connection error.',
      requestId: init.requestId,
      cause: init.cause,
    });
  }
}

/** The request exceeded its configured timeout before a response was received. */
export class APITimeoutError extends APIConnectionError {
  constructor(init: APIConnectionErrorInit) {
    super({ ...init, message: init.message ?? 'Request timed out.' });
  }
}

/** Extra, non-response-derived context for {@link fromResponse}. */
export interface FromResponseExtra {
  /** Overrides the request id otherwise read from the `x-request-id` header or the body's `correlationId`. */
  requestId?: string;
  cause?: unknown;
}

/**
 * Build the right {@link HopeAPIError} subclass for a non-2xx `Response`,
 * given its already-parsed body (JSON, or `undefined` if the body was empty
 * or not JSON). Never reads bodies out of `response` itself — callers parse
 * once and pass the result in, since the response stream can only be
 * consumed a single time.
 */
export function fromResponse(response: Response, body: unknown, extra: FromResponseExtra = {}): HopeAPIError {
  const status = response.status;
  const requestId = extra.requestId ?? response.headers.get('x-request-id') ?? readCorrelationId(body) ?? undefined;
  const code = readCode(body);
  const message = readMessage(body);
  const common: HopeAPIErrorInit = {
    status,
    message,
    code,
    requestId,
    headers: response.headers,
    cause: extra.cause,
  };

  switch (status) {
    case 401:
      return new AuthenticationError(common);
    case 403:
      return new PermissionError(common);
    case 404:
      return new NotFoundError(common);
    case 409:
      return new QuotaExceededError(common);
    case 412:
      return new VersionConflictError({ ...common, currentVersion: readCurrentVersion(body) });
    case 428:
      return new PreconditionRequiredError(common);
    case 429:
      return new RateLimitError({
        ...common,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
      });
    default:
      return new HopeAPIError(common);
  }
}
