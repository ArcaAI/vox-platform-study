/**
 * The one place the harness issues a request.
 *
 * Plain `globalThis.fetch` on purpose. Node 24 ships undici behind it with an
 * Agent that already does keep-alive and has no per-origin connection cap, so a
 * custom dispatcher would add a dependency (`undici` is only a transitive here)
 * to re-create the default. Anything this module needs beyond fetch — timing,
 * header capture, a timeout that is recorded rather than thrown away — is a few
 * lines of its own.
 *
 * Every response is measured and attributed here so no call site can
 * accidentally record a failure as a success, or forget to classify one.
 */
import { attribute, type Attribution } from './attribution';
import type { PrincipalKind, RequestSample } from './types';

export interface Credential {
  readonly kind: PrincipalKind;
  readonly tenantId: string;
  /** Label used in the report. Never a secret. */
  readonly label: string;
  /** Headers this credential contributes — `Authorization`, `X-API-Key` or `X-Service-Account-Token`. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface IssueOptions {
  readonly baseUrl: string;
  readonly credential: Credential;
  readonly method: string;
  /** Path relative to `baseUrl`, no leading slash (e.g. `admin/tenants`). */
  readonly path: string;
  /** Route TEMPLATE for reporting. Defaults to `path`; pass explicitly when the path carries an id. */
  readonly routeKey?: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly pgConnectTimeoutMs: number;
  readonly lane?: 'per_ip' | 'per_tenant' | 'indeterminate';
  readonly directPeer?: boolean;
  /** ms since the run's t0 at which this request was DUE. Drives `scheduleDelayMs`. */
  readonly dueAtMs?: number;
  /** The run's t0, as `Date.now()`. */
  readonly t0Ms: number;
}

export interface IssueResult {
  readonly sample: RequestSample;
  readonly attribution: Attribution;
  /** Parsed body, exposed only so credential bootstrap can read a token out of it. */
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

function collectHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Read the body without letting it distort the measurement.
 *
 * The body is always drained — an undrained undici response keeps its socket
 * out of the pool, which would slowly starve a long run of connections and
 * present as rising latency that has nothing to do with the platform. Only the
 * first 64 KiB is PARSED, because a large 200 payload costs more to JSON.parse
 * than to receive and that cost would land in the latency number.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0 || text.length > 64 * 1024) return null;
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function issue(options: IssueOptions): Promise<IssueResult> {
  const url = `${options.baseUrl.replace(/\/$/, '')}/${options.path.replace(/^\//, '')}`;
  const routeKey = `${options.method} ${options.routeKey ?? options.path}`;

  const headers: Record<string, string> = { accept: 'application/json', ...options.credential.headers };
  let payload: string | undefined;
  if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }

  const startedAt = Date.now();
  let status: number | null = null;
  let responseHeaders: Record<string, string> = {};
  let body: unknown = null;
  let transportError: string | undefined;

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: 'manual',
    });
    status = response.status;
    responseHeaders = collectHeaders(response.headers);
    body = await readBody(response);
  } catch (error) {
    // A timeout is a transport failure from the CLIENT's point of view and is
    // recorded as one. It is never dropped: a run that silently discards its
    // timeouts reports a beautiful p99 for the requests that happened to finish.
    transportError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  const durationMs = Date.now() - startedAt;
  const attribution = attribute({
    status,
    headers: responseHeaders,
    body,
    durationMs,
    transportError,
    lane: options.lane,
    pgConnectTimeoutMs: options.pgConnectTimeoutMs,
    directPeer: options.directPeer,
  });

  const sample: RequestSample = {
    startedAtMs: startedAt - options.t0Ms,
    durationMs,
    scheduleDelayMs: options.dueAtMs === undefined ? 0 : Math.max(0, startedAt - options.t0Ms - options.dueAtMs),
    method: options.method,
    routeKey,
    tenantId: options.credential.tenantId,
    principalKind: options.credential.kind,
    status,
    ok: attribution.cause === null,
    cause: attribution.cause,
    causeDetail: attribution.detail,
    correlationId: attribution.correlationId,
    rateLimit: attribution.rateLimit,
  };

  return { sample, attribution, body, headers: responseHeaders };
}
