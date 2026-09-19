/**
 * TASK-993 lane H item 1 — the Prisma pool saturation series.
 *
 * OD-3 answered "how does the platform scale?" with *"fix the pool and drive
 * the HPA off a saturation signal"*. The cluster lane then found there was no
 * such signal to drive it with: nothing on `/metrics` reported pool depth,
 * acquire wait or acquire timeouts, so a `connectionTimeoutMillis` rejection
 * was client-indistinguishable from any other 500 and the HPA had to fall back
 * to held-connection count as a proxy.
 *
 * These tests assert the SCRAPE OUTPUT, not the internals: what the HPA's
 * prometheus-adapter rule matches is a line in the exposition text, so that is
 * what is pinned. Nothing is mocked — every observation is driven through the
 * real `registerPgPool` instrumentation and the real classifier, by pools
 * whose `connect()` settles the way `pg-pool`'s would. That pg-pool genuinely
 * produces those rejections is pinned on the other side of the seam, in
 * `packages/database/src/__tests__/pool-observability.test.ts`, which drives a
 * real `pg.Pool` to exhaustion.
 */
import { getPgPoolStats, registerPgPool, resetPgPoolObservability } from '@arcaai/database';
import { register } from 'prom-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gatewayMetricPrefix } from '../metric-naming';
import { installPrismaPoolMetrics, PRISMA_POOL_METRICS } from '../prisma-pool-metrics';

const originalEnv = { ...process.env };
let uninstall: (() => void) | undefined;

interface Depth {
  max: number;
  total: number;
  idle: number;
  waiting: number;
}

interface PoolDouble {
  connect: () => Promise<unknown>;
  ending?: boolean;
}

/**
 * Register a depth-reporting pool double under `role`.
 *
 * `pg` is not a dependency of `apps/api`, so the `pg.Pool` type is not
 * importable here and the cast happens once, at this seam.
 */
function registerDouble(
  role: 'extended' | 'platform-admin' | 'vault' | 'adhoc',
  depth: Depth,
  connect: () => Promise<unknown> = async () => ({}),
): PoolDouble {
  const pool: PoolDouble = {
    options: { max: depth.max },
    totalCount: depth.total,
    idleCount: depth.idle,
    waitingCount: depth.waiting,
    connect,
  } as PoolDouble;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerPgPool(role, pool as any);
  return pool;
}

beforeEach(() => {
  process.env = { ...originalEnv, OTEL_SERVICE_NAME: 'hope-api', METRICS_PREFIX: '' };
  resetPgPoolObservability();
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  resetPgPoolObservability();
  process.env = originalEnv;
});

describe('installPrismaPoolMetrics', () => {
  it('publishes the series names the cluster lane asked for, under the gateway prefix', async () => {
    uninstall = installPrismaPoolMetrics();
    registerDouble('extended', { max: 10, total: 6, idle: 2, waiting: 3 });

    const scrape = await register.metrics();
    const prefix = gatewayMetricPrefix();

    expect(prefix).toBe('hope_api_');
    for (const suffix of Object.values(PRISMA_POOL_METRICS)) {
      expect(scrape).toContain(`${prefix}${suffix}`);
    }
  });

  it('reads pool depth AT SCRAPE TIME, so a gauge is never a stale snapshot', async () => {
    uninstall = installPrismaPoolMetrics();
    const prefix = gatewayMetricPrefix();

    // Nothing registered yet: the family exists but carries no sample.
    expect(await register.getSingleMetricAsString(`${prefix}${PRISMA_POOL_METRICS.waiting}`)).not.toMatch(/prisma_pool_waiting\{/);

    registerDouble('extended', { max: 10, total: 6, idle: 2, waiting: 3 });
    const scrape = await register.metrics();

    expect(scrape).toContain(`${prefix}prisma_pool_waiting{role="extended"} 3`);
    expect(scrape).toContain(`${prefix}prisma_pool_in_use{role="extended"} 4`);
    expect(scrape).toContain(`${prefix}prisma_pool_idle{role="extended"} 2`);
    expect(scrape).toContain(`${prefix}prisma_pool_max{role="extended"} 10`);
  });

  it("keeps the gateway's two pools apart — the number must not be silently halved", async () => {
    uninstall = installPrismaPoolMetrics();
    registerDouble('extended', { max: 10, total: 10, idle: 0, waiting: 8 });
    registerDouble('platform-admin', { max: 10, total: 2, idle: 2, waiting: 0 });

    const prefix = gatewayMetricPrefix();
    const scrape = await register.metrics();
    expect(scrape).toContain(`${prefix}prisma_pool_in_use{role="extended"} 10`);
    expect(scrape).toContain(`${prefix}prisma_pool_in_use{role="platform-admin"} 0`);
    expect(scrape).toContain(`${prefix}prisma_pool_waiting{role="extended"} 8`);
    expect(scrape).toContain(`${prefix}prisma_pool_waiting{role="platform-admin"} 0`);
  });

  it('stops reporting a role whose pool has retired, instead of freezing its last depth', async () => {
    uninstall = installPrismaPoolMetrics();
    const pool = registerDouble('vault', { max: 10, total: 9, idle: 0, waiting: 4 });
    expect(await register.metrics()).toContain(`${gatewayMetricPrefix()}prisma_pool_waiting{role="vault"} 4`);

    // `ending` is what `Pool.end()` sets synchronously.
    pool.ending = true;

    expect(await register.metrics()).toContain(`${gatewayMetricPrefix()}prisma_pool_waiting{role="vault"} 0`);
  });

  it('observes an acquire into the wait histogram', async () => {
    uninstall = installPrismaPoolMetrics();
    const pool = registerDouble('extended', { max: 5, total: 1, idle: 0, waiting: 0 });

    await pool.connect();

    expect(await register.metrics()).toContain(`${gatewayMetricPrefix()}prisma_pool_wait_seconds_count{role="extended"} 1`);
  });

  it('places a genuinely slow acquire in a high bucket, not the fastest one', async () => {
    uninstall = installPrismaPoolMetrics();
    const pool = registerDouble(
      'extended',
      { max: 1, total: 1, idle: 0, waiting: 1 },
      () => new Promise((resolve) => setTimeout(() => resolve({}), 60)),
    );

    await pool.connect();

    const histogram = await register.getSingleMetric(`${gatewayMetricPrefix()}${PRISMA_POOL_METRICS.waitSeconds}`)!.get();
    const bucket = (le: number) => histogram.values.find((v) => (v as { metricName?: string }).metricName?.endsWith('_bucket') && v.labels.le === le)?.value;
    // 60 ms: above the 25 ms edge, at or below the 100 ms one.
    expect(bucket(0.025)).toBe(0);
    expect(bucket(0.1)).toBe(1);
  });

  it('counts a pool-exhaustion timeout under the reason that names the right lever', async () => {
    uninstall = installPrismaPoolMetrics();
    const pool = registerDouble('extended', { max: 1, total: 1, idle: 0, waiting: 1 }, () =>
      Promise.reject(new Error('timeout exceeded when trying to connect')),
    );

    await expect(pool.connect()).rejects.toThrow();
    await expect(pool.connect()).rejects.toThrow();

    expect(await register.metrics()).toContain(
      `${gatewayMetricPrefix()}prisma_pool_acquire_timeouts_total{role="extended",reason="pool_exhausted"} 2`,
    );
    expect(getPgPoolStats()[0]).toMatchObject({ poolExhaustedTimeouts: 2 });
  });

  it('counts an unreachable-Postgres timeout separately — opposite remedy', async () => {
    uninstall = installPrismaPoolMetrics();
    const pool = registerDouble('platform-admin', { max: 1, total: 0, idle: 0, waiting: 0 }, () =>
      Promise.reject(new Error('Connection terminated due to connection timeout')),
    );

    await expect(pool.connect()).rejects.toThrow();

    expect(await register.metrics()).toContain(
      `${gatewayMetricPrefix()}prisma_pool_acquire_timeouts_total{role="platform-admin",reason="connect_timeout"} 1`,
    );
  });

  it('does not count a successful acquire, or an unrelated fault, as a timeout', async () => {
    uninstall = installPrismaPoolMetrics();
    const ok = registerDouble('extended', { max: 5, total: 1, idle: 1, waiting: 0 });
    const refused = registerDouble('adhoc', { max: 5, total: 0, idle: 0, waiting: 0 }, () =>
      Promise.reject(new Error('ECONNREFUSED 127.0.0.1:5432')),
    );

    await ok.connect();
    await expect(refused.connect()).rejects.toThrow();

    expect(await register.metrics()).not.toMatch(/prisma_pool_acquire_timeouts_total\{/);
  });

  it('is idempotent — a second install must not throw a duplicate-registration error', () => {
    uninstall = installPrismaPoolMetrics();
    expect(() => installPrismaPoolMetrics()()).not.toThrow();
  });

  it('carries no tenant label — pool contention is a process property, not a tenant one', async () => {
    uninstall = installPrismaPoolMetrics();
    const pool = registerDouble('extended', { max: 10, total: 1, idle: 0, waiting: 0 });
    await pool.connect();

    const poolLines = (await register.metrics()).split('\n').filter((line) => line.includes('prisma_pool') && !line.startsWith('#'));
    expect(poolLines.length).toBeGreaterThan(0);
    expect(poolLines.filter((line) => /tenant/i.test(line))).toEqual([]);
  });
});
