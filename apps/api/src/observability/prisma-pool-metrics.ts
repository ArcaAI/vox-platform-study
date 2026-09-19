/**
 * The Prisma/pg connection-pool saturation series (TASK-993 lane H, OD-3).
 *
 * ============================================================================
 * THE PROBLEM THIS SOLVES
 * ============================================================================
 * The gateway HPA is `Resource / cpu / averageUtilization: 75`. The gateway is
 * I/O-bound: under pool exhaustion requests QUEUE on a 5-connection pool while
 * CPU stays low, so that trigger can never fire on the real bottleneck
 * (TASK-993 §2.10). The owner's answer (OD-3) was to drive the HPA off a
 * saturation signal instead — and the cluster lane then found there was none
 * to drive it with. Nothing on `/metrics` reported pool depth, acquire wait or
 * acquire timeouts, so `out-of-band/prometheus-adapter.yaml` had to settle for
 * held-connection count as a proxy and says so in its own comment:
 *
 *   > ⚠ IT IS A PROXY, NOT THE REAL THING. The true signal is pool ACQUISITION
 *   > WAIT, and no such series exists […] Adding
 *   > `hope_api_prisma_pool_wait_seconds` (histogram) and
 *   > `hope_api_prisma_pool_in_use` (gauge) in arca/hope-v2 is what would let
 *   > this rule be replaced by a direct measurement.
 *
 * This module is that. The names below are the names that comment asks for,
 * under the prefix the cluster actually resolves (`metric-naming.ts`).
 *
 * ============================================================================
 * THE SEAM
 * ============================================================================
 * `packages/database` owns MEASUREMENT and carries no metrics library — it is
 * imported by seeds, migration scripts and CLI tools with no registry. This
 * module owns REPRESENTATION. Two directions, chosen per quantity:
 *
 * - **Depth is a level** → pulled at SCRAPE time from `getPgPoolStats()` in a
 *   `collect()` callback. Zero cost between scrapes, and never stale.
 * - **An acquire is an event** → pushed through `addPgAcquireObserver`.
 *   Sampling waits at scrape time would miss every acquire in between.
 *
 * ============================================================================
 * WHAT AN OPERATOR SHOULD READ
 * ============================================================================
 * | Series | Reads |
 * |---|---|
 * | `…prisma_pool_waiting{role}` | callers BLOCKED on a connection right now. Non-zero == saturated. The most direct signal here. |
 * | `…prisma_pool_in_use{role}` / `…prisma_pool_max{role}` | utilisation, as a ratio you can threshold |
 * | `…prisma_pool_wait_seconds{role}` | how LONG acquires are taking. `rate(_sum)` is request-seconds lost to contention per second — i.e. the number of requests permanently parked on the pool. |
 * | `…prisma_pool_acquire_timeouts_total{role,reason}` | the failure itself. `reason="pool_exhausted"` says add capacity; `reason="connect_timeout"` says Postgres is unreachable — opposite levers. |
 *
 * There is deliberately **no tenant label**: the pool is a process resource
 * shared by every tenant, so a tenant facet would multiply every series by the
 * tenant count to answer nothing, on an endpoint scraped by anything on the
 * network path.
 */
import { addPgAcquireObserver, getPgPoolStats } from '@arcaai/database';
import { Counter, Gauge, Histogram, register, type Metric } from 'prom-client';

import { gatewayMetricPrefix } from './metric-naming';

/** Unprefixed metric-name suffixes, so a test can assert the published set. */
export const PRISMA_POOL_METRICS = {
  inUse: 'prisma_pool_in_use',
  idle: 'prisma_pool_idle',
  max: 'prisma_pool_max',
  waiting: 'prisma_pool_waiting',
  waitSeconds: 'prisma_pool_wait_seconds',
  acquireTimeouts: 'prisma_pool_acquire_timeouts_total',
} as const;

/**
 * Bucket edges for the acquire wait, in seconds.
 *
 * Bounded by the pool's own `connectionTimeoutMillis: 5_000` — past 5s the
 * acquire has already failed, so a bucket beyond it could only ever hold the
 * `+Inf` overflow. The low end is dense because a HEALTHY acquire is sub-
 * millisecond (an idle connection handed straight over): if the p99 has moved
 * off the first bucket at all, the pool is already queueing.
 */
const WAIT_BUCKETS = [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] as const;

/**
 * Reuse an already-registered metric rather than constructing a second one.
 *
 * prom-client THROWS on a duplicate name, and `installPrismaPoolMetrics()` can
 * legitimately run twice (a test that boots two apps; a future second
 * bootstrap path). A throw during bootstrap over a metric would be a worse
 * outcome than a shared instance.
 */
function reuseOrCreate<T extends Metric>(name: string, create: () => T): T {
  return (register.getSingleMetric(name) as T | undefined) ?? create();
}

/**
 * Register the pool series on prom-client's global register (the one
 * `PrometheusModule` serves at `GET /metrics`) and subscribe to acquires.
 *
 * Call this from `main.ts` AFTER `loadEnv()` — the prefix is env-derived — and
 * BEFORE `NestFactory.create()`, because the DI warmup issues the first
 * queries and an observer registered later would miss them.
 *
 * @returns an uninstall function that unsubscribes and removes the series.
 *   Nothing in the running gateway calls it; it exists so a test can leave the
 *   global register as it found it.
 */
export function installPrismaPoolMetrics(): () => void {
  const prefix = gatewayMetricPrefix();
  const name = (suffix: string) => `${prefix}${suffix}`;

  /**
   * One gauge per quantity, each filled from a single `getPgPoolStats()` read
   * at scrape time. `reset()` first: a role whose pool has retired must stop
   * reporting a depth rather than freeze at its last value.
   */
  const depthGauge = (suffix: string, help: string, pick: (stats: ReturnType<typeof getPgPoolStats>[number]) => number) =>
    reuseOrCreate(
      name(suffix),
      () =>
        new Gauge({
          name: name(suffix),
          help,
          labelNames: ['role'] as const,
          registers: [register],
          collect() {
            this.reset();
            for (const stats of getPgPoolStats()) this.set({ role: stats.role }, pick(stats));
          },
        }),
    );

  const inUse = depthGauge(
    PRISMA_POOL_METRICS.inUse,
    'Prisma/pg pool connections currently executing a query, by pool role. Ratio against ..._max is the pool utilisation.',
    (s) => s.inUse,
  );
  const idle = depthGauge(PRISMA_POOL_METRICS.idle, 'Prisma/pg pool connections established and free, by pool role.', (s) => s.idle);
  const max = depthGauge(
    PRISMA_POOL_METRICS.max,
    'Prisma/pg pool connection ceiling (PRISMA_PG_MAX), summed over the pools holding each role. pods x sum(this) is the load on PostgreSQL max_connections.',
    (s) => s.max,
  );
  const waiting = depthGauge(
    PRISMA_POOL_METRICS.waiting,
    'Callers BLOCKED waiting for a Prisma/pg pool connection, by pool role. Non-zero means requests are queueing on the pool while CPU may read low — the saturation signal a CPU-based HPA cannot see.',
    (s) => s.waiting,
  );

  const waitSeconds = reuseOrCreate(
    name(PRISMA_POOL_METRICS.waitSeconds),
    () =>
      new Histogram({
        name: name(PRISMA_POOL_METRICS.waitSeconds),
        help: 'Time to acquire a Prisma/pg pool connection (queue wait, plus handshake when the pool grew instead of queueing), by pool role. rate(_sum) is request-seconds lost to pool contention per second.',
        labelNames: ['role'] as const,
        buckets: [...WAIT_BUCKETS],
        registers: [register],
      }),
  );

  const acquireTimeouts = reuseOrCreate(
    name(PRISMA_POOL_METRICS.acquireTimeouts),
    () =>
      new Counter({
        name: name(PRISMA_POOL_METRICS.acquireTimeouts),
        help: 'Prisma/pg pool acquires that timed out. reason="pool_exhausted" means every connection was busy (add pool or replicas); reason="connect_timeout" means a new connection could not be established (PostgreSQL is unreachable or out of max_connections).',
        labelNames: ['role', 'reason'] as const,
        registers: [register],
      }),
  );

  const unsubscribe = addPgAcquireObserver(({ role, waitSeconds: seconds, outcome }) => {
    waitSeconds.observe({ role }, seconds);
    // `ok` is the overwhelming majority and is already counted by the
    // histogram; `error` is a connection fault this counter does not claim to
    // explain. Only the two timeouts are a capacity statement.
    if (outcome === 'pool_exhausted' || outcome === 'connect_timeout') {
      acquireTimeouts.inc({ role, reason: outcome });
    }
  });

  return () => {
    unsubscribe();
    for (const metric of [inUse, idle, max, waiting, waitSeconds, acquireTimeouts]) {
      register.removeSingleMetric((metric as unknown as { name: string }).name);
    }
  };
}
