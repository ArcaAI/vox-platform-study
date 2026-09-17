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
 * The house `{ message, code, problems? }` shape (`.claude/rules/05-nestjs-api.md`) carries
 * `problems` as an array of human-readable strings — one per validation failure (e.g. a
 * `WORKFLOW_CONTEXT_INCOMPATIBLE` refusal's unmet context-schema requirements). Read for every
 * 4xx status, not just 400: the shape is not status-specific.
 */
function readProblems(body: unknown): string[] | undefined {
  if (!isRecord(body)) return undefined;
  const { problems } = body;
  if (!Array.isArray(problems)) return undefined;
  const strings = problems.filter((p): p is string => typeof p === 'string');
  return strings.length > 0 ? strings : undefined;
}

/**
 * Parse a `Retry-After` header value (RFC 9110 §10.2.3) into milliseconds.
 * Accepts either form:
 * - delta-seconds: `"30"` → 30_000
 * - HTTP-date: `"Wed, 21 Oct 2026 07:28:00 GMT"` → (date - now), clamped to 0
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
    case 400:
      return 'The request was rejected as malformed.';
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
    case 504:
      return 'The gateway stopped waiting — the work continues.';
    default:
      return `Request failed with status ${status}.`;
  }
}

/** Constructor options shared by every {@link HopeAPIError} subclass. */
export interface HopeAPIErrorInit {
  status: number;
  message?: string;
  code?: string;
  /** One human-readable string per validation failure, from the house `{ message, code, problems? }` body shape. */
  problems?: string[];
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
  /** One human-readable string per validation failure, when the body carried `problems`. */
  readonly problems?: string[];
  readonly requestId?: string;
  readonly headers?: Headers;

  constructor(init: HopeAPIErrorInit) {
    super(init.message ?? defaultMessageForStatus(init.status), {
      cause: init.cause,
    });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.problems = init.problems;
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
 * upstream and never echoes model output — see `text-compat.controller.ts`.
 */
export class HopeStreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HopeStreamError';
    // Same prototype fix-up rationale as HopeAPIError above.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * HTTP 400 — the gateway rejected the request shape.
 *
 * On the workflow invocation plane this is, in practice, one thing: a
 * RESERVED RUN-IDENTITY FIELD in `input` (`consultationId`,
 * `externalPatientId`, `userId`, `jobId`, `sessionId`). The gateway refuses
 * rather than silently dropping them, because a silent drop would hand you a
 * 202 for a run that addressed something other than what you named.
 *
 * This SDK refuses those keys BEFORE the request is issued
 * ({@link ReservedRunIdentityError}), so reaching this class from a run call
 * generally means the gateway's list has grown past the SDK's copy — worth
 * reporting rather than working around.
 *
 * The global `ValidationPipe` also runs `forbidNonWhitelisted`, so an
 * undeclared body field is a 400 too, never a silently-ignored extra.
 */
export class BadRequestError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    super({ ...init, status: 400 });
  }
}

/** HTTP 401 — the API key (or bearer token) was missing, invalid, or expired. */
export class AuthenticationError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    super({ ...init, status: 401 });
  }
}

/** HTTP 403 — a privilege boundary, e.g. a super-admin-only action attempted by a tenant admin. */
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

/**
 * HTTP 504 — `mode=blocking` hit the gateway's ~60s ceiling.
 *
 * **This is NOT a failed run, and treating it as one is the mistake this class
 * exists to prevent.** The ceiling is on how long the gateway will hold an
 * HTTP connection open, not on the work: the run is a durable Temporal
 * execution and is still going. Retrying the POST would start (and bill) a
 * SECOND run unless you sent an `Idempotency-Key`.
 *
 * The recovery is to stop blocking and start watching. The gateway's own 504
 * body names the `statusUrl` and `streamUrl` to use, and this SDK gives you
 * both directly:
 *
 * ```ts
 * try {
 *   return await hope.workflows.runAndWait('visit-summary', { input });
 * } catch (err) {
 *   if (err instanceof GatewayTimeoutError) {
 *     // Long run — watch it instead of waiting on a socket.
 *     for await (const event of hope.workflows.runAndStream('visit-summary', { input }, { idempotencyKey: key })) { … }
 *   }
 *   throw err;
 * }
 * ```
 *
 * (Reusing the same `Idempotency-Key` is what makes that second call JOIN the
 * run you already started rather than begin a new one.)
 */
export class GatewayTimeoutError extends HopeAPIError {
  constructor(init: Omit<HopeAPIErrorInit, 'status'>) {
    const serverMessage = init.message?.trim() || defaultMessageForStatus(504);
    super({
      ...init,
      status: 504,
      message: `${serverMessage} (The run is still executing — this is a ceiling on the HTTP wait, not a failure. Stream or poll it; do not retry without the same Idempotency-Key.)`,
    });
  }
}

/**
 * Thrown by the SDK — never by the gateway — when a workflow `input` carries a
 * key the server stamps itself.
 *
 * A client-side error class rather than a `BadRequestError` because nothing was
 * sent: there is no status, no request id, and no server message to carry. See
 * `core/run-identity.ts` for why the SDK refuses instead of leaving it to the
 * 400.
 */
export class ReservedRunIdentityError extends Error {
  /** Every offending key, in the order the reserved list declares them. */
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(
      `Workflow input may not contain the reserved run-identity ${keys.length === 1 ? 'key' : 'keys'} ${keys.map((k) => `\`${k}\``).join(', ')}. ` +
        'The server stamps run identity itself — a consultation is named by the URL ' +
        '(`hope.consultations.workflows.run(consultationId, slug, …)`), never by the body. ' +
        'Remove ' +
        (keys.length === 1 ? 'it' : 'them') +
        ' from `input`; the gateway would otherwise answer 400.',
    );
    this.name = 'ReservedRunIdentityError';
    this.keys = keys;
    // Same prototype fix-up rationale as HopeAPIError above.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by the SDK when a client authenticated as a SERVICE ACCOUNT reaches
 * for a surface only an API key can use.
 *
 * The workflow invocation plane is one of those: `route-manifest.json` records
 * `svcScopes: []` on every one of its routes, and no scope declaration means
 * deny-by-default. A service-account client would therefore get a 403 that
 * reads like a permissions misconfiguration — an integrator would go looking
 * for a scope to grant, and there is none to grant.
 *
 * Refusing at the call site says the true thing: this is the wrong credential
 * CLASS for this plane, and the fix is a different client, not a wider role.
 */
export class CredentialClassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialClassError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when `transport: 'socket'` is asked for on a runtime with no `globalThis.WebSocket`.
 *
 * This package ships ZERO runtime dependencies, so the socket lane is the platform global and
 * nothing else — which makes the WebSocket's availability the runtime floor, not a detail. Node
 * gained a global `WebSocket` in 22; Bun, Deno and edge runtimes have always had one.
 *
 * Deliberately NOT a silent fallback to SSE. `socket` is chosen for a reason — usually a proxy
 * that buffers `text/event-stream` — and quietly serving the transport the caller ruled out
 * would reproduce the exact symptom they switched away from, with nothing in the logs to say so.
 */
export class SocketUnavailableError extends Error {
  /**
   * @param surface Names the caller that needed the socket, so the message
   * points at the thing the integrator actually wrote. Defaults to the workflow
   * run lane, which was the only socket surface before TASK-933 added
   * `hope.stt.socket`.
   * @param remedy What to do instead. The workflow lane has an SSE alternative;
   * the realtime STT protocol has none — it is a socket protocol — so the
   * remedy there is the runtime, and saying otherwise would send an integrator
   * looking for a fallback that does not exist.
   */
  constructor(
    surface = "`transport: 'socket'`",
    remedy = "Upgrade the runtime, or stay on the default SSE lane (`transport: 'sse'`), which is also the only lane that resumes with `Last-Event-ID`.",
  ) {
    super(
      `${surface} needs a global \`WebSocket\`, and this runtime has none. That means Node 22 or newer (the release that ` +
        'added it), or any of Bun / Deno / an edge runtime. `@arcaai/vox-node` has zero runtime dependencies and will not import a ' +
        `polyfill on your behalf. ${remedy}`,
    );
    this.name = 'SocketUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link DnaWritingStyleResource.waitForIngestJob | `DnaWritingStyleResource#waitForIngestJob`}
 * (`resources/dna-writing-style.ts`) when a DNA-writing-style ingest job has
 * not reached a terminal status (`'completed'`/`'failed'`) before its
 * `timeoutMs` elapses.
 *
 * The job itself is not necessarily stuck — this route has no SSE stream to
 * fall back to (unlike `hope.jobs.waitFor`), so the ceiling here is purely
 * how long THIS CALL polled, not a statement about the job's own health.
 * Recovery is to poll `getIngestJob(jobId)` yourself, or call
 * `waitForIngestJob` again with the same `jobId` and a longer `timeoutMs`.
 */
export class DnaIngestJobTimeoutError extends Error {
  /** The job that was being awaited. */
  readonly jobId: string;
  /** The `timeoutMs` that elapsed. */
  readonly timeoutMs: number;

  constructor(jobId: string, timeoutMs: number) {
    super(`DNA writing-style ingest job "${jobId}" did not reach a terminal status within ${timeoutMs}ms.`);
    this.name = 'DnaIngestJobTimeoutError';
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
    // Same prototype fix-up rationale as HopeAPIError above.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A BATCH TRANSCRIPTION job did not finish in time.
 *
 * Thrown by {@link AgentsResource.waitForTranscription | `AgentsResource#waitForTranscription`}
 * when the job has not reached a terminal status (`COMPLETED` / `FAILED` / `CANCELLED` / `DEAD`)
 * before its `timeoutMs` elapses. Like `DnaIngestJobTimeoutError`, the ceiling describes how long
 * THIS CALL polled, not the job's health: the job may still complete. Recovery is
 * `transcriptionJob(jobId)`, `subscribeTranscription(jobId, …)`, or another
 * `waitForTranscription` with a longer `timeoutMs`.
 */
export class TranscriptionJobTimeoutError extends Error {
  /** The job that was being awaited. */
  readonly jobId: string;
  /** The `timeoutMs` that elapsed. */
  readonly timeoutMs: number;

  constructor(jobId: string, timeoutMs: number) {
    super(`Transcription job "${jobId}" did not reach a terminal status within ${timeoutMs}ms.`);
    this.name = 'TranscriptionJobTimeoutError';
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
    // Same prototype fix-up rationale as HopeAPIError above.
    Object.setPrototypeOf(this, new.target.prototype);
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
  const problems = readProblems(body);
  const common: HopeAPIErrorInit = {
    status,
    message,
    code,
    problems,
    requestId,
    headers: response.headers,
    cause: extra.cause,
  };

  switch (status) {
    case 400:
      return new BadRequestError(common);
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
    case 504:
      return new GatewayTimeoutError(common);
    default:
      return new HopeAPIError(common);
  }
}
