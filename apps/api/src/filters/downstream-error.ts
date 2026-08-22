/**
 * TASK-768 — the ONE place a failed downstream call becomes a client-facing body.
 *
 * Background. A request to a route that forwards to `apps/text` (:8862) while
 * that service was down surfaced as:
 *
 *     400 {"message":"Failed to call TEXT service: AggregateError: connect
 *          ECONNREFUSED ::1:8862; connect ECONNREFUSED 127.0.0.1:8862", …}
 *
 * Two defects in one body. The status blamed the CALLER for an absent
 * DEPENDENCY, and the message handed the caller the gateway's internal
 * topology. Both happened because the call site composed the message itself.
 *
 * The rule this module encodes: **call sites throw (or rethrow) the CAUSE;
 * only the boundary builds the body.** `ExceptionInterceptor` is that boundary
 * — it already does exactly this job for Prisma errors, where the full detail
 * goes to the log and the client gets `{statusCode, error, correlationId}`.
 *
 * Everything here is pure and side-effect free so it can be unit-tested
 * directly and reused by the few proxy controllers that must keep their own
 * frozen v1-compat body SHAPES but should still take their STATUS from one
 * classifier.
 */
import { HttpStatus } from '@nestjs/common';

/** Seconds a client should wait before retrying a 503. Small on purpose: a restarted peer is usually back within one of these. */
export const DOWNSTREAM_RETRY_AFTER_SECONDS = 5;

/** Stable machine-readable code on every downstream-failure body. */
export const DOWNSTREAM_ERROR_CODE = 'GATEWAY.DOWNSTREAM_UNAVAILABLE';

/**
 * Why the downstream call failed — classified by CAUSE, never by what the
 * client sent.
 *
 *  - `transport`            — the gateway never reached the peer.
 *  - `upstream_server_error`— the peer answered 5xx.
 *  - `upstream_client_error`— the peer answered 4xx (a genuine bad request).
 */
export type DownstreamFailureKind = 'transport' | 'upstream_server_error' | 'upstream_client_error';

/**
 * Every errno the Node / undici / axios stack raises when a peer is
 * unreachable, DNS fails, or the socket dies mid-flight. A miss here is a 500
 * (or, historically, a 400) in production, so this list is deliberately wide:
 * over-classifying a genuine bug as "downstream unavailable" costs a retry;
 * under-classifying an outage costs a misleading status on every request.
 */
const TRANSPORT_ERRNOS = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'ECONNABORTED',
  'EADDRNOTAVAIL',
  'EPROTO',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Transport failures that arrive with no usable `code` — `fetch`/undici and
 * some agents surface them as a bare message. Matched against the message only
 * AFTER the structured checks fail.
 */
const TRANSPORT_MESSAGE_PATTERN = new RegExp(
  ['socket hang up', 'getaddrinfo', 'network error', 'fetch failed', 'client network socket disconnected', ...TRANSPORT_ERRNOS].join('|'),
  'i',
);

type ErrorLike = {
  code?: unknown;
  errno?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
  response?: { status?: unknown } | undefined;
};

function asErrorLike(err: unknown): ErrorLike | null {
  return typeof err === 'object' && err !== null ? (err as ErrorLike) : null;
}

/** The upstream HTTP status, when the peer actually answered. */
function upstreamStatusOf(err: unknown): number | undefined {
  const e = asErrorLike(err);
  const status = e?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Walks the whole failure graph — the error itself, its `cause` chain, and any
 * `AggregateError.errors` members — looking for a transport errno.
 *
 * The `AggregateError` walk is not hypothetical: Node's happy-eyeballs dialer
 * produces exactly that when a service is down on both `::1` and `127.0.0.1`,
 * and the AggregateError itself carries NO `code` — the errnos live only on its
 * members. That is the shape the TASK-764 evidence captured.
 */
function hasTransportCause(err: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  const e = asErrorLike(err);
  if (!e) return false;

  if (typeof e.code === 'string' && TRANSPORT_ERRNOS.has(e.code)) return true;
  if (typeof e.errno === 'string' && TRANSPORT_ERRNOS.has(e.errno)) return true;

  if (Array.isArray(e.errors) && e.errors.some((member) => hasTransportCause(member, depth + 1))) return true;
  if (e.cause !== undefined && hasTransportCause(e.cause, depth + 1)) return true;

  return typeof e.message === 'string' && TRANSPORT_MESSAGE_PATTERN.test(e.message);
}

/**
 * Classify a caught error as a downstream failure, or `null` if it is not one.
 *
 * `null` means "not mine" — the caller must leave the error alone so the
 * existing mappings (Prisma, domain exceptions, plain `HttpException`s) keep
 * their behaviour.
 */
export function classifyDownstreamFailure(err: unknown): DownstreamFailureKind | null {
  const upstreamStatus = upstreamStatusOf(err);
  if (upstreamStatus !== undefined) {
    if (upstreamStatus >= 500) return 'upstream_server_error';
    if (upstreamStatus >= 400) return 'upstream_client_error';
    return null; // a 2xx/3xx that still threw is a mapping bug, not a downstream failure
  }
  return hasTransportCause(err) ? 'transport' : null;
}

/**
 * Cause ⇒ status.
 *
 *  - `transport` ⇒ **503**. The gateway never reached the dependency
 *    (RFC 9110 §15.6.4), and 503 is the only 5xx RFC 9110 pairs with
 *    `Retry-After`. This is the retry-me case.
 *  - `upstream_server_error` ⇒ **502**. The gateway DID reach the dependency
 *    and got an invalid response from it (§15.6.3). Deliberately distinct from
 *    503 so alerting can separate "dependency down" from "dependency erroring"
 *    on status alone, and deliberately without `Retry-After` — an immediate
 *    retry usually reproduces it.
 *  - `upstream_client_error` ⇒ the upstream's own 4xx, propagated. The caller's
 *    request really was rejected; only the BODY is sanitized.
 *
 * A transport failure can never yield a 4xx — that inversion is the defect this
 * module exists to prevent.
 */
export function downstreamStatusFor(kind: DownstreamFailureKind, upstreamStatus?: number): number {
  switch (kind) {
    case 'transport':
      return HttpStatus.SERVICE_UNAVAILABLE;
    case 'upstream_server_error':
      return HttpStatus.BAD_GATEWAY;
    case 'upstream_client_error':
      return typeof upstreamStatus === 'number' && upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : HttpStatus.BAD_GATEWAY;
  }
}

// ---------------------------------------------------------------------------
// Topology detection & redaction
// ---------------------------------------------------------------------------

/**
 * Patterns that constitute internal topology. None of these may appear in a
 * client-facing body: host, port, IP literal, URL, errno, absolute file path,
 * or a stack frame.
 */
const TOPOLOGY_PATTERNS: RegExp[] = [
  /https?:\/\/\S+/i, // a URL
  /\[?[0-9a-f]*:{2}[0-9a-f:]*\]?:\d{2,5}\b/i, // IPv6 (incl. `::1:8862`)
  /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/, // IPv4, with or without a port
  /\b(?=[a-z0-9_.-]*[a-z])[a-z0-9_.-]+:\d{2,5}\b/i, // host:port — the host must contain a letter, so `12:34` is not a match
  /\bat\s+\S+\s*\(.*:\d+:\d+\)/, // a stack frame
  /(?:^|\s)(?:\.{0,2}\/)(?:[\w.-]+\/)+[\w.-]+/, // an absolute or relative file path
  /\b(?:node_modules|AxiosError|AggregateError)\b/,
];

/** Errnos are a REASON, not topology — but they must still never reach a client body. */
const ERRNO_PATTERN = new RegExp(`\\b(?:${[...TRANSPORT_ERRNOS].join('|')})\\b`);

/**
 * True if `text` carries anything that identifies the gateway's internals.
 *
 * This is the predicate the regression sweeps assert on — it is exported so the
 * unit tests, the route sweep, and the source sweep all hold the codebase to
 * exactly one definition of "leak" rather than three drifting ones.
 */
export function containsTopology(text: string): boolean {
  if (!text) return false;
  return ERRNO_PATTERN.test(text) || TOPOLOGY_PATTERNS.some((p) => p.test(text));
}

/**
 * Strip topology from a string while keeping it legible.
 *
 * For the handful of surfaces that must keep a real reason for an OPERATOR
 * (the admin health probe reports why each service is down; a job-status stream
 * relays a BullMQ `failedReason`) but are still delivered over a client-facing
 * response. The errno survives — it is a reason, not an address; the host, port,
 * IP and URL do not.
 */
export function redactTopology(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(/https?:\/\/\S+/gi, '[redacted-url]');
  out = out.replace(/\[?[0-9a-f]*:{2}[0-9a-f:]*\]?:\d{2,5}\b/gi, '[redacted-address]');
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, '[redacted-address]');
  out = out.replace(/\b(?=[a-z0-9_.-]*[a-z])[a-z0-9_.-]+:\d{2,5}\b/gi, '[redacted-address]');
  out = out.replace(/(?:^|\s)(?:\.{0,2}\/)(?:[\w.-]+\/)+[\w.-]+/g, ' [redacted-path]');
  return out.trim();
}

// ---------------------------------------------------------------------------
// Capability naming — the client learns WHAT is unavailable, never WHERE it is
// ---------------------------------------------------------------------------

const GENERIC_CAPABILITY = 'A required downstream capability';

/**
 * Route → capability phrase. Ordered: the first match wins, so the more
 * specific `…/summary/async` (harness) precedes `…/summary` (text).
 *
 * Deriving the capability from the ROUTE rather than from the call site means a
 * newly added downstream call on an existing route is labelled correctly with
 * no cooperation from its author — which is the same reason the body is built
 * here rather than there.
 */
const CAPABILITY_BY_PATH: Array<[RegExp, string]> = [
  [/\/summary\/(?:async|pre-summary\/async)|\/pre-summary\/async/, 'Note generation'],
  [/\/(?:admin|internal)\/harness\b|\/workflow-runs?\b|\/workflows\b/, 'Note generation'],
  [/\/speech\b|\/tts\b/, 'Speech synthesis'],
  [/\/transcription-jobs\b|\/api\/stt\b|\/internal\/stt\b|\/stt\b/, 'Transcription'],
  [/\/text-analyses\b|\/safety-checks\b|\/diagnosis-suggestions\b|\/ai\//, 'AI text analysis'],
  // `\/api\/smr\b` matches the FROZEN v1 compat prefix `api/smr/api/v1` (owner
  // decision 704), which D-740-1 deliberately does not rename — so this literal
  // must stay `smr` even though the service is `text` everywhere else.
  [/\/summary\b|\/prompt-templates\/[^/]+\/test|\/text-generations\b|\/api\/smr\b|\/text\b/, 'Text'],
];

/** The user-facing name of the capability a path depends on. Never contains topology. */
export function capabilityForPath(path: string | undefined): string {
  if (!path) return GENERIC_CAPABILITY;
  for (const [pattern, capability] of CAPABILITY_BY_PATH) {
    if (pattern.test(path)) return capability;
  }
  return GENERIC_CAPABILITY;
}

// ---------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------

export interface DownstreamErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code: typeof DOWNSTREAM_ERROR_CODE;
  correlationId: string | undefined;
}

const STATUS_LABEL: Record<number, string> = {
  [HttpStatus.SERVICE_UNAVAILABLE]: 'Service Unavailable',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
};

/**
 * Build the client-facing body. This is the only function in the codebase
 * permitted to do so for a downstream failure.
 *
 * The message names the CAPABILITY and nothing else. The `correlationId` is the
 * caller's handle into the operator-side log written alongside it — that pair
 * ("stable opaque message + correlationId to the client, everything to the
 * operator") is the whole contract.
 */
export function buildDownstreamErrorBody(input: { status: number; capability: string; correlationId: string | undefined }): DownstreamErrorBody {
  const { status, capability, correlationId } = input;

  const message =
    status === HttpStatus.SERVICE_UNAVAILABLE
      ? `${capability} is temporarily unavailable. Please retry.`
      : status === HttpStatus.BAD_GATEWAY
        ? `${capability} returned an invalid response.`
        : `${capability} rejected the request.`;

  return {
    statusCode: status,
    error: STATUS_LABEL[status] ?? 'Bad Request',
    message,
    code: DOWNSTREAM_ERROR_CODE,
    correlationId,
  };
}

/**
 * The operator's half of the contract: everything the client did not get.
 *
 * Host, port, errno, upstream status and the whole `AggregateError` /`cause`
 * fan-out, for the server-side log keyed by the same `correlationId` the client
 * received. Deliberately NOT the upstream response BODY — that can echo the
 * assembled clinical prompt (PHI), and stdout ships to Loki outside PHI
 * controls. The existing proxy controllers already log an
 * `upstreamBodyRedacted` sentinel for the same reason.
 */
export function describeCauseForOperator(err: unknown): Record<string, unknown> {
  const e = asErrorLike(err);
  const nested: string[] = [];

  const collect = (candidate: unknown, depth: number): void => {
    if (depth > 5) return;
    const c = asErrorLike(candidate);
    if (!c) return;
    if (typeof c.message === 'string') nested.push(c.message);
    if (Array.isArray(c.errors)) c.errors.forEach((m) => collect(m, depth + 1));
    if (c.cause !== undefined) collect(c.cause, depth + 1);
  };
  if (Array.isArray(e?.errors)) e.errors.forEach((m) => collect(m, 1));
  if (e?.cause !== undefined) collect(e.cause, 1);

  return {
    causeType: (err as { constructor?: { name?: string } })?.constructor?.name,
    causeCode: typeof e?.code === 'string' ? e.code : undefined,
    causeMessage: typeof e?.message === 'string' ? e.message : String(err),
    upstreamStatus: upstreamStatusOf(err),
    nestedCauses: nested.length > 0 ? nested : undefined,
    upstreamBodyRedacted: upstreamStatusOf(err) !== undefined,
  };
}
