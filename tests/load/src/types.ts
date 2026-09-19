/**
 * Shared types for the TASK-993 load harness.
 *
 * Kept dependency-free on purpose: every module under `src/` that imports this
 * must stay runnable from a plain `tsx` entry point with no repo build step.
 */

/**
 * Why a request did not succeed.
 *
 * "It failed" is useless for a capacity question — TASK-993 §2.9 lists five
 * different ceilings that all present as a failed request, and the only thing
 * worth measuring is WHICH one bound first. Every member below maps to exactly
 * one ceiling in that table, or to the harness/transport itself.
 */
export type FailureCause =
  /** 429 from `TieredThrottlerGuard` on a bucket keyed by the caller's IP (ranks 4-5, or any non-default tier). */
  | 'throttle_ip'
  /** 429 from `TieredThrottlerGuard` on a bucket keyed by the caller's TENANT (ranks 1-3). */
  | 'throttle_tenant'
  /** 429 from the throttler where the lane (IP vs tenant) could not be resolved. Never silently folded into either. */
  | 'throttle_unknown'
  /** 429/409/413/403 from entitlements (`DOMAIN.QUOTA_EXCEEDED`). Sub-attributed by `capability`. */
  | 'entitlement_quota'
  /** 503 + `GATEWAY.DOWNSTREAM_UNAVAILABLE` — the gateway never reached the Python peer. */
  | 'downstream_unreachable'
  /** 502 + `GATEWAY.DOWNSTREAM_UNAVAILABLE` — the Python peer answered 5xx. A capacity-guard 503 lands HERE, not on 503. */
  | 'downstream_5xx'
  /** A Python service answered 503 directly (only observable on the direct-peer lane, which bypasses the gateway). */
  | 'peer_capacity_503'
  /** 504 — an ingress/proxy hop gave up. */
  | 'gateway_timeout'
  /** 500 whose latency sits in the pg pool `connectionTimeoutMillis` band. SUSPECTED, never asserted — see attribution.ts. */
  | 'db_pool_timeout_suspected'
  /** Any other 5xx. */
  | 'server_error'
  /** 401/403 that is not a quota denial — a credential problem in the harness or the fixture. */
  | 'auth'
  /** Any other 4xx — almost always a harness bug (bad body, wrong route), so it is never counted as platform capacity. */
  | 'client_error'
  /** `fetch` threw: connection refused/reset, DNS, socket hang up, abort/timeout. The CLIENT never got a status. */
  | 'transport';

/** Which credential class issued the request. They share a tenant bucket, so they must be reported apart. */
export type PrincipalKind = 'human' | 'api_key' | 'service_account';

/** One completed (or failed) request. The atom every report is derived from. */
export interface RequestSample {
  /** ms since the run's t0, when the request was ISSUED. */
  readonly startedAtMs: number;
  /** Wall-clock duration in ms, including connect + TLS + body read. */
  readonly durationMs: number;
  /** ms by which this request slipped behind its intended schedule. The coordinated-omission correction. */
  readonly scheduleDelayMs: number;
  readonly method: string;
  /** Route TEMPLATE (`GET /api/v1/tenants/:id`), never a resolved URL — otherwise the report has unbounded cardinality. */
  readonly routeKey: string;
  readonly tenantId: string;
  readonly principalKind: PrincipalKind;
  /** null when the request never got a status (see `cause: 'transport'`). */
  readonly status: number | null;
  readonly ok: boolean;
  readonly cause: FailureCause | null;
  /** Free-form second level of attribution: the quota `capability`, the downstream `capability`, the throttled tier. */
  readonly causeDetail?: string;
  /** `correlationId` from the error envelope — the operator's handle into the gateway log for anything unattributed. */
  readonly correlationId?: string;
  /** Rate-limit observations lifted off the response, used by the lane probe. */
  readonly rateLimit?: RateLimitObservation;
}

/** What a single response told us about the limiter. Every field is optional because a 429 carries almost none of it. */
export interface RateLimitObservation {
  /** `X-RateLimit-Limit` — the ENFORCED limit. Present on 2xx only (throttler v6 skips these headers on the blocked path). */
  readonly limit?: number;
  /** `X-RateLimit-Remaining`. Present on 2xx only. */
  readonly remaining?: number;
  /** `X-RateLimit-Reset`, seconds. Present on 2xx only. */
  readonly resetSeconds?: number;
  /** `RateLimit-Policy` advisory field, verbatim. */
  readonly policy?: string;
  /** Seconds from `Retry-After`. Present on a 429 (and on a downstream 503). */
  readonly retryAfterSeconds?: number;
  /** The throttler tier named by the `Retry-After` SUFFIX (TASK-993 D-4). `default` when unsuffixed. */
  readonly tier?: string;
}

/** The verdict of the lane probe: how the limiter buckets THIS credential class on THIS route set. */
export type BucketLane = 'per_ip' | 'per_tenant' | 'indeterminate';

export interface LaneVerdict {
  readonly lane: BucketLane;
  /** Human-readable evidence, printed in the report. Never omitted — an unexplained verdict is not a measurement. */
  readonly evidence: string[];
  /** The enforced limit observed while probing, when one was advertised. */
  readonly observedLimit?: number;
}

/** A single screen's burst of queries, as a real console mount issues them. */
export interface ScreenStep {
  readonly method: string;
  /** Path relative to the gateway's `/api/v1` prefix, e.g. `tenants`. Templates use `:id`. */
  readonly path: string;
  /** Optional JSON body. */
  readonly body?: unknown;
  /** Skip this step unless the principal is of one of these kinds. */
  readonly principals?: readonly PrincipalKind[];
}

export interface Screen {
  readonly name: string;
  /** Relative likelihood a virtual user navigates here next. */
  readonly weight: number;
  /** The queries this screen fires on mount, issued CONCURRENTLY — that burstiness is the point. */
  readonly steps: readonly ScreenStep[];
}

export interface HarnessConfig {
  readonly baseUrl: string;
  readonly tenants: number;
  readonly usersPerTenant: number;
  readonly apiKeysPerTenant: number;
  readonly serviceAccountsPerTenant: number;
  readonly durationSeconds: number;
  readonly rampSeconds: number;
  /** Median of the log-normal think time between screen navigations. */
  readonly thinkMedianMs: number;
  /** Sigma of the underlying normal. 0.6 gives a realistically long tail. */
  readonly thinkSigma: number;
  /** `closed` holds concurrency fixed (models "100 concurrent users"). `open` holds ARRIVAL RATE fixed (finds the break). */
  readonly arrival: 'closed' | 'open';
  /** Worker threads to shard virtual users across, so the client is not the bottleneck. */
  readonly workers: number;
  /** Per-request timeout. A request still in flight at this point is recorded as `transport`, not dropped. */
  readonly requestTimeoutMs: number;
  /** `connectionTimeoutMillis` of the gateway's pg pool. Drives the `db_pool_timeout_suspected` band. */
  readonly pgConnectTimeoutMs: number;
  /** Scrape `GET /metrics` before and after the run for the server's own view. */
  readonly scrapeMetrics: boolean;
  /** Ask the platform which routes each credential can reach, and drop the rest, before the timed run. */
  readonly calibrate: boolean;
  /** Seconds to wait after the probes so the limiter windows they spent roll over. */
  readonly cooldownSeconds: number;
}
