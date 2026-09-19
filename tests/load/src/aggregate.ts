/**
 * The shape a worker ships home, and how several of them combine.
 *
 * Everything here is plain data — arrays, numbers and string-keyed records — so
 * it crosses a `worker_threads` boundary through structured clone without a
 * serializer, and so the whole aggregation is pure and unit-testable.
 */
import { createHistogram, merge as mergeHistogram, record, type Histogram } from './stats';
import type { FailureCause, PrincipalKind, RequestSample } from './types';

export interface RouteStats {
  total: number;
  ok: number;
  failed: number;
  latency: Histogram;
}

/** One second of the run. Reveals WHEN a ceiling bound, which the totals cannot. */
export interface TimelineBucket {
  requests: number;
  ok: number;
  throttled: number;
  failed: number;
}

export interface Aggregate {
  startedAtMs: number;
  durationSeconds: number;
  total: number;
  ok: number;
  latency: Histogram;
  scheduleDelay: Histogram;
  latencyByPrincipal: Record<PrincipalKind, Histogram>;
  byCause: Record<string, number>;
  /** `cause :: detail` → count. The second level of attribution (which capability, which tier). */
  byCauseDetail: Record<string, number>;
  byRoute: Record<string, RouteStats>;
  byTenant: Record<string, { total: number; ok: number; failed: number }>;
  timeline: TimelineBucket[];
  /** ms offset of the FIRST throttled response. The effective budget, read directly off the run. */
  firstThrottleAtMs: number | null;
  /** Correlation ids of 5xx the harness could not attribute — the operator's handle into the gateway log. */
  unattributedCorrelationIds: string[];
  /** Enforced limits advertised on 2xx, per route. Evidence for which rank supplied the number. */
  observedLimits: Record<string, number>;
}

const PRINCIPALS: readonly PrincipalKind[] = ['human', 'api_key', 'service_account'];
const THROTTLE_CAUSES: ReadonlySet<FailureCause> = new Set<FailureCause>(['throttle_ip', 'throttle_tenant', 'throttle_unknown']);
/** Cap so a pathological run cannot blow memory shipping a million ids home. */
const MAX_CORRELATION_IDS = 200;

export function createAggregate(startedAtMs: number, durationSeconds: number): Aggregate {
  return {
    startedAtMs,
    durationSeconds,
    total: 0,
    ok: 0,
    latency: createHistogram(),
    scheduleDelay: createHistogram(),
    latencyByPrincipal: { human: createHistogram(), api_key: createHistogram(), service_account: createHistogram() },
    byCause: {},
    byCauseDetail: {},
    byRoute: {},
    byTenant: {},
    timeline: Array.from({ length: Math.max(1, durationSeconds) }, () => ({ requests: 0, ok: 0, throttled: 0, failed: 0 })),
    firstThrottleAtMs: null,
    unattributedCorrelationIds: [],
    observedLimits: {},
  };
}

export function add(aggregate: Aggregate, sample: RequestSample): void {
  aggregate.total += 1;
  record(aggregate.latency, sample.durationMs);
  record(aggregate.scheduleDelay, sample.scheduleDelayMs);
  record(aggregate.latencyByPrincipal[sample.principalKind], sample.durationMs);

  const route = (aggregate.byRoute[sample.routeKey] ??= { total: 0, ok: 0, failed: 0, latency: createHistogram() });
  route.total += 1;
  record(route.latency, sample.durationMs);

  const tenant = (aggregate.byTenant[sample.tenantId] ??= { total: 0, ok: 0, failed: 0 });
  tenant.total += 1;

  // Clamp rather than drop: a request that started a hair past the deadline is
  // real load, and discarding it would understate the tail it contributed to.
  const second = Math.min(aggregate.timeline.length - 1, Math.max(0, Math.floor(sample.startedAtMs / 1000)));
  const bucket = aggregate.timeline[second]!;
  bucket.requests += 1;

  if (sample.ok) {
    aggregate.ok += 1;
    route.ok += 1;
    tenant.ok += 1;
    bucket.ok += 1;
    // Only a 2xx carries `X-RateLimit-Limit` (throttler v6 skips the headers on
    // the blocked path), so this is the only place the enforced limit is visible.
    if (sample.rateLimit?.limit !== undefined) aggregate.observedLimits[sample.routeKey] = sample.rateLimit.limit;
    return;
  }

  route.failed += 1;
  tenant.failed += 1;
  bucket.failed += 1;

  const cause = sample.cause ?? 'unknown';
  aggregate.byCause[cause] = (aggregate.byCause[cause] ?? 0) + 1;
  if (sample.causeDetail) {
    const key = `${cause} :: ${sample.causeDetail}`;
    aggregate.byCauseDetail[key] = (aggregate.byCauseDetail[key] ?? 0) + 1;
  }

  if (sample.cause && THROTTLE_CAUSES.has(sample.cause)) {
    bucket.throttled += 1;
    if (aggregate.firstThrottleAtMs === null || sample.startedAtMs < aggregate.firstThrottleAtMs) {
      aggregate.firstThrottleAtMs = sample.startedAtMs;
    }
  }

  if ((sample.cause === 'server_error' || sample.cause === 'db_pool_timeout_suspected') && sample.correlationId) {
    if (aggregate.unattributedCorrelationIds.length < MAX_CORRELATION_IDS) {
      aggregate.unattributedCorrelationIds.push(sample.correlationId);
    }
  }
}

/** Fold a worker's aggregate into the run total. */
export function mergeAggregate(target: Aggregate, source: Aggregate): Aggregate {
  target.total += source.total;
  target.ok += source.ok;
  mergeHistogram(target.latency, source.latency);
  mergeHistogram(target.scheduleDelay, source.scheduleDelay);
  for (const kind of PRINCIPALS) mergeHistogram(target.latencyByPrincipal[kind], source.latencyByPrincipal[kind]);

  for (const [cause, count] of Object.entries(source.byCause)) target.byCause[cause] = (target.byCause[cause] ?? 0) + count;
  for (const [detail, count] of Object.entries(source.byCauseDetail)) target.byCauseDetail[detail] = (target.byCauseDetail[detail] ?? 0) + count;

  for (const [routeKey, stats] of Object.entries(source.byRoute)) {
    const existing = (target.byRoute[routeKey] ??= { total: 0, ok: 0, failed: 0, latency: createHistogram() });
    existing.total += stats.total;
    existing.ok += stats.ok;
    existing.failed += stats.failed;
    mergeHistogram(existing.latency, stats.latency);
  }

  for (const [tenantId, stats] of Object.entries(source.byTenant)) {
    const existing = (target.byTenant[tenantId] ??= { total: 0, ok: 0, failed: 0 });
    existing.total += stats.total;
    existing.ok += stats.ok;
    existing.failed += stats.failed;
  }

  const span = Math.max(target.timeline.length, source.timeline.length);
  for (let i = 0; i < span; i += 1) {
    const from = source.timeline[i];
    if (!from) continue;
    const into = (target.timeline[i] ??= { requests: 0, ok: 0, throttled: 0, failed: 0 });
    into.requests += from.requests;
    into.ok += from.ok;
    into.throttled += from.throttled;
    into.failed += from.failed;
  }

  if (source.firstThrottleAtMs !== null) {
    target.firstThrottleAtMs =
      target.firstThrottleAtMs === null ? source.firstThrottleAtMs : Math.min(target.firstThrottleAtMs, source.firstThrottleAtMs);
  }
  for (const id of source.unattributedCorrelationIds) {
    if (target.unattributedCorrelationIds.length < MAX_CORRELATION_IDS) target.unattributedCorrelationIds.push(id);
  }
  Object.assign(target.observedLimits, source.observedLimits);

  return target;
}
