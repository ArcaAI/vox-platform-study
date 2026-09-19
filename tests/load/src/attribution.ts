/**
 * Turn one HTTP response into ONE named ceiling.
 *
 * This file is the whole point of the harness. TASK-993 §2.9 lists five
 * ceilings — rate limit, Prisma pool, gateway event loop, BullMQ, STT streams —
 * and every one of them presents to a client as "a request failed". A run that
 * reports a failure COUNT tells you nothing about which of the five to raise.
 *
 * Everything here is pure, so it is unit-tested directly against the exact
 * bodies and headers the gateway emits (see `__tests__/attribution.test.ts`);
 * nothing in the attribution path needs a running platform to be verified.
 *
 * ## The signals, and where each comes from in the gateway
 *
 * - `@nestjs/throttler@6.5.0` sets `X-RateLimit-Limit/-Remaining/-Reset` ONLY on
 *   the allowed path. On a block it throws BEFORE that block runs and sets only
 *   `Retry-After`. So a 429 carries almost no rate-limit metadata — which is why
 *   the lane has to be established separately (`lane-probe.ts`) rather than read
 *   off the 429.
 * - The tier suffix on `Retry-After` is TASK-993 defect D-4: throttler v6 emits
 *   `Retry-After-<name>` for every non-`default` tier. The defect is that SDKs
 *   cannot read it — but for a MEASUREMENT it is a gift, because it names the
 *   tier that blocked, and `TieredThrottlerGuard` never applies a tenant-keyed
 *   bucket to a non-default tier. A suffixed `Retry-After` is therefore a
 *   DEFINITIVE per-IP attribution, with no probe needed.
 * - Entitlements quota blocks come through `ExceptionInterceptor` as
 *   `code: 'DOMAIN.QUOTA_EXCEEDED'` with `metadata.capability`, and
 *   `mapQuotaCapabilityToHttp` makes the rolling-meter and concurrency caps
 *   **429** — the same status as the throttler. Checking the body BEFORE the
 *   status is therefore mandatory, not defensive.
 * - `apps/api/src/filters/downstream-error.ts` maps a Python peer that ANSWERED
 *   5xx to **502**, and a peer the gateway could not REACH to **503**. A
 *   `CapacityGuard` 503 from `apps/stt` is an upstream 5xx, so at the gateway
 *   boundary it arrives as 502 — not 503. Attributing "Python at capacity" to a
 *   client-visible 503 would be exactly backwards.
 */
import type { FailureCause, RateLimitObservation } from './types';

/** `code` on every downstream-failure body (`filters/downstream-error.ts`). */
export const DOWNSTREAM_ERROR_CODE = 'GATEWAY.DOWNSTREAM_UNAVAILABLE';
/** `code` on every entitlements quota block (`QuotaExceededException.toJSON()`). */
export const QUOTA_ERROR_CODE = 'DOMAIN.QUOTA_EXCEEDED';

/** Everything the attributor is allowed to look at. Deliberately no `Response` object — this stays pure. */
export interface AttributionInput {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Parsed JSON body, or null when the body was empty / not JSON. */
  readonly body: unknown;
  readonly durationMs: number;
  /** Set when `fetch` itself threw. */
  readonly transportError?: string;
  /** The lane the probe established for this credential class, if it ran. */
  readonly lane?: 'per_ip' | 'per_tenant' | 'indeterminate';
  /** The gateway's pg `connectionTimeoutMillis`. */
  readonly pgConnectTimeoutMs: number;
  /** True when the request bypassed the gateway and hit a Python service directly. */
  readonly directPeer?: boolean;
}

export interface Attribution {
  readonly cause: FailureCause | null;
  readonly detail?: string;
  readonly correlationId?: string;
  readonly rateLimit?: RateLimitObservation;
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  // Node's fetch lowercases header names; a hand-built map might not.
  return headers[name] ?? headers[name.toLowerCase()];
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The `Retry-After` family, resolved to the tier that produced it.
 *
 * `default` → `Retry-After`; every other tier → `Retry-After-<tier>` (D-4).
 * Returns `undefined` when no member of the family is present.
 */
export function readRetryAfter(headers: Readonly<Record<string, string>>): { tier: string; seconds: number | undefined } | undefined {
  const plain = header(headers, 'retry-after');
  if (plain !== undefined) return { tier: 'default', seconds: num(plain) };

  for (const [rawKey, value] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (key.startsWith('retry-after-')) {
      return { tier: key.slice('retry-after-'.length), seconds: num(value) };
    }
  }
  return undefined;
}

/** Lift every rate-limit signal a response carries. Present on 2xx AND on the sparse 429. */
export function readRateLimit(headers: Readonly<Record<string, string>>): RateLimitObservation | undefined {
  const retry = readRetryAfter(headers);
  const observation: RateLimitObservation = {
    limit: num(header(headers, 'x-ratelimit-limit')),
    remaining: num(header(headers, 'x-ratelimit-remaining')),
    resetSeconds: num(header(headers, 'x-ratelimit-reset')),
    policy: header(headers, 'ratelimit-policy'),
    retryAfterSeconds: retry?.seconds,
    tier: retry?.tier,
  };
  return Object.values(observation).some((v) => v !== undefined) ? observation : undefined;
}

/**
 * Attribute one response to one ceiling.
 *
 * Order is load-bearing and is asserted by the unit tests:
 *   1. transport (no status at all)
 *   2. quota (a 429 that is NOT the throttler — body before status)
 *   3. throttler (by tier suffix first, then by the probed lane)
 *   4. downstream (502/503 carrying the gateway's downstream code)
 *   5. 504 / pool-timeout band / other 5xx
 *   6. auth / other 4xx
 */
export function attribute(input: AttributionInput): Attribution {
  const rateLimit = readRateLimit(input.headers);
  const body = asRecord(input.body);
  const correlationId = typeof body?.['correlationId'] === 'string' ? (body['correlationId'] as string) : undefined;
  const code = typeof body?.['code'] === 'string' ? (body['code'] as string) : undefined;
  const base = { correlationId, rateLimit };

  // 1. The client never got a status.
  if (input.status === null) {
    return { ...base, cause: 'transport', detail: input.transportError ?? 'unknown transport failure' };
  }

  if (input.status >= 200 && input.status < 400) {
    return { ...base, cause: null };
  }

  // 2. Entitlements. MUST precede the throttler branch: `mapQuotaCapabilityToHttp`
  //    answers 429 for every rolling-meter and concurrency capability, so a quota
  //    block and a rate-limit block are the same status and differ only in the body.
  if (code === QUOTA_ERROR_CODE) {
    const metadata = asRecord(body?.['metadata']);
    const capability = typeof metadata?.['capability'] === 'string' ? (metadata['capability'] as string) : 'unknown';
    return { ...base, cause: 'entitlement_quota', detail: `${capability} (HTTP ${input.status})` };
  }

  // 3. The throttler.
  if (input.status === 429) {
    const tier = rateLimit?.tier;

    // A NON-default tier is never tenant-keyed: `TieredThrottlerGuard.handleRequest`
    // returns `super.handleRequest(...)` for `name !== 'default'` without supplying a
    // `getTracker`/`generateKey`, so the library's own per-IP tracker stands. This is
    // a definitive attribution and needs no probe.
    if (tier !== undefined && tier !== 'default') {
      return { ...base, cause: 'throttle_ip', detail: `tier=${tier} (non-default tiers are always IP-keyed)` };
    }

    // The default tier can be either lane, and the 429 itself carries no evidence
    // of which. Defer to the probe rather than guessing — a wrong lane here is a
    // wrong fix in TASK-993 lane D/F.
    if (input.lane === 'per_tenant') return { ...base, cause: 'throttle_tenant', detail: 'tier=default, lane probe: per-tenant' };
    if (input.lane === 'per_ip') return { ...base, cause: 'throttle_ip', detail: 'tier=default, lane probe: per-IP' };
    return { ...base, cause: 'throttle_unknown', detail: 'tier=default, lane not established' };
  }

  // 4. A Python peer, seen through the gateway.
  if (code === DOWNSTREAM_ERROR_CODE) {
    // The body names the CAPABILITY and never the host (that redaction is
    // deliberate in `downstream-error.ts`), which is exactly the granularity a
    // capacity report wants.
    const capability = typeof body?.['message'] === 'string' ? (body['message'] as string).replace(/ is .*$/, '') : 'unknown capability';
    if (input.status === 503) return { ...base, cause: 'downstream_unreachable', detail: capability };
    return { ...base, cause: 'downstream_5xx', detail: `${capability} (upstream 5xx → HTTP ${input.status})` };
  }

  // A 503 straight off a Python service — only reachable on the direct-peer lane,
  // because the gateway rewrites an upstream 5xx to 502 (branch 4 above).
  if (input.status === 503 && input.directPeer) {
    return { ...base, cause: 'peer_capacity_503', detail: 'python service answered 503' };
  }

  if (input.status === 504) {
    return { ...base, cause: 'gateway_timeout', detail: 'proxy/ingress hop gave up' };
  }

  // 5. The Prisma pool.
  //
  // A pg pool-acquire timeout is NOT an HttpException and NOT a BaseException, and
  // `classifyDownstreamFailure` does not claim it (its message matches no transport
  // errno), so it lands on the generic 500 with a body of `{statusCode, message:
  // 'Internal server error'}`. At the client boundary that is indistinguishable
  // from any other 500 — EXCEPT that the pool rejects at a fixed
  // `connectionTimeoutMillis` (5_000 ms in `packages/database/src/client.ts`), so
  // these 500s pile up in a tight band while ordinary 500s do not.
  //
  // This is a HEURISTIC and is named one. The `correlationId` is carried through
  // so an operator can settle it against the gateway log; the gateway exposes no
  // pool metric to settle it from the outside (see README §"What this cannot tell
  // you").
  if (input.status === 500 && withinPoolTimeoutBand(input.durationMs, input.pgConnectTimeoutMs)) {
    return {
      ...base,
      cause: 'db_pool_timeout_suspected',
      detail: `500 at ${Math.round(input.durationMs)}ms, inside the ${input.pgConnectTimeoutMs}ms pool-acquire band`,
    };
  }

  if (input.status >= 500) {
    return { ...base, cause: 'server_error', detail: code ?? `HTTP ${input.status}` };
  }

  // 6. Client-side. Counted apart from platform capacity on purpose: a 400 here is
  //    almost always a harness bug, and folding it into "failures" would inflate the
  //    breaking point the run reports.
  if (input.status === 401 || input.status === 403) {
    return { ...base, cause: 'auth', detail: code ?? `HTTP ${input.status}` };
  }
  return { ...base, cause: 'client_error', detail: code ?? `HTTP ${input.status}` };
}

/**
 * Is this latency consistent with a pool-acquire timeout?
 *
 * Lower edge at 90% of the configured timeout (timers fire slightly early under
 * load); upper edge at +60% to absorb the queueing the request did BEFORE it
 * asked the pool for a connection.
 */
export function withinPoolTimeoutBand(durationMs: number, pgConnectTimeoutMs: number): boolean {
  return durationMs >= pgConnectTimeoutMs * 0.9 && durationMs <= pgConnectTimeoutMs * 1.6;
}

/** Causes that mean "a platform ceiling refused the work" — the numerator of the capacity verdict. */
export const CEILING_CAUSES: ReadonlySet<FailureCause> = new Set<FailureCause>([
  'throttle_ip',
  'throttle_tenant',
  'throttle_unknown',
  'entitlement_quota',
  'downstream_unreachable',
  'downstream_5xx',
  'peer_capacity_503',
  'gateway_timeout',
  'db_pool_timeout_suspected',
  'server_error',
]);

/** Causes that indicate the HARNESS or the FIXTURE is wrong, not the platform. Reported separately and loudly. */
export const HARNESS_FAULT_CAUSES: ReadonlySet<FailureCause> = new Set<FailureCause>(['auth', 'client_error']);
