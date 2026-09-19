/**
 * TASK-993 lane H — the pool saturation signal OD-3 depends on.
 *
 * These tests deliberately drive a REAL `pg.Pool` (with a stub `Client`, so no
 * Postgres is needed) rather than a hand-rolled double. The whole point of the
 * module is to read `pg-pool`'s own counters and recognise `pg-pool`'s own
 * timeout rejection; a fake pool would only prove the test agrees with itself.
 */
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addPgAcquireObserver,
  classifyPgAcquireError,
  createObservedPgAdapter,
  getPgPoolStats,
  type PgAcquireObservation,
  registerPgPool,
  resetPgPoolObservability,
} from '../pool-observability.js';

/**
 * A `pg.Client` stand-in whose `connect()` NEVER calls back.
 *
 * That is what makes a genuine pool-exhaustion reachable offline: the first
 * acquire occupies the pool's only slot forever, so the second one ages out of
 * `pg-pool`'s pending queue and rejects with the real library's real message.
 *
 * `connection`/`isConnected()` are read by `pg-pool`'s own new-connection
 * timeout; answering "connected, no stream" makes it a no-op so the first
 * acquire simply hangs instead of being torn down.
 */
class NeverConnectingClient {
  readonly connection = undefined;
  connect(): void {
    /* deliberately never calls back */
  }
  isConnected(): boolean {
    return true;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  end(callback?: () => void): void {
    callback?.();
  }
}

/** A pool with `max` slots, none of which will ever become usable. */
function saturatedPool(connectionTimeoutMillis: number): Pool {
  return new Pool({
    max: 1,
    connectionTimeoutMillis,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg-pool's documented injection point for a custom Client
    Client: NeverConnectingClient as any,
  });
}

/** A pool object that reports fixed depth — for the aggregation arithmetic only. */
function stubPool(depth: { max: number; total: number; idle: number; waiting: number }): Pool {
  return {
    options: { max: depth.max },
    totalCount: depth.total,
    idleCount: depth.idle,
    waitingCount: depth.waiting,
    connect: () => Promise.resolve({} as never),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Pool;
}

afterEach(() => {
  resetPgPoolObservability();
  vi.restoreAllMocks();
});

describe('classifyPgAcquireError', () => {
  it("maps pg-pool's queue timeout to pool_exhausted, not a generic error", () => {
    expect(classifyPgAcquireError(new Error('timeout exceeded when trying to connect'))).toBe('pool_exhausted');
  });

  it('maps a failed handshake to connect_timeout — a DIFFERENT lever from pool exhaustion', () => {
    expect(classifyPgAcquireError(new Error('Connection terminated due to connection timeout'))).toBe('connect_timeout');
  });

  it('does not mis-file an unrelated failure as saturation', () => {
    expect(classifyPgAcquireError(new Error('ECONNREFUSED 127.0.0.1:5432'))).toBe('error');
  });

  it('treats an absent error as a successful acquire', () => {
    expect(classifyPgAcquireError(undefined)).toBe('ok');
    expect(classifyPgAcquireError(null)).toBe('ok');
  });
});

describe('getPgPoolStats', () => {
  it('aggregates every pool holding the same role, so a second pool cannot hide', () => {
    registerPgPool('adhoc', stubPool({ max: 5, total: 4, idle: 1, waiting: 2 }));
    registerPgPool('adhoc', stubPool({ max: 5, total: 3, idle: 3, waiting: 0 }));

    const stats = getPgPoolStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ role: 'adhoc', pools: 2, max: 10, total: 7, idle: 4, inUse: 3, waiting: 2 });
  });

  it('reports each role separately — the two-pool problem the gateway actually has', () => {
    registerPgPool('extended', stubPool({ max: 10, total: 10, idle: 0, waiting: 7 }));
    registerPgPool('platform-admin', stubPool({ max: 10, total: 1, idle: 1, waiting: 0 }));

    const byRole = Object.fromEntries(getPgPoolStats().map((s) => [s.role, s]));
    expect(byRole.extended).toMatchObject({ inUse: 10, waiting: 7 });
    expect(byRole['platform-admin']).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it('omits a role with no pool rather than inventing a zero', () => {
    registerPgPool('extended', stubPool({ max: 5, total: 0, idle: 0, waiting: 0 }));
    expect(getPgPoolStats().map((s) => s.role)).toEqual(['extended']);
  });

  it('never reports a negative inUse when idle is observed above total mid-mutation', () => {
    registerPgPool('extended', stubPool({ max: 5, total: 1, idle: 2, waiting: 0 }));
    expect(getPgPoolStats()[0]?.inUse).toBe(0);
  });

  it('is idempotent for the same pool object (Prisma may connect() more than once)', () => {
    const pool = stubPool({ max: 5, total: 2, idle: 0, waiting: 0 });
    registerPgPool('extended', pool);
    registerPgPool('extended', pool);
    expect(getPgPoolStats()[0]).toMatchObject({ pools: 1, total: 2 });
  });
});

describe('acquire instrumentation against a real pg.Pool', () => {
  it("observes a pool-exhaustion timeout and counts it, using pg-pool's own rejection", async () => {
    const seen: PgAcquireObservation[] = [];
    addPgAcquireObserver((o) => seen.push(o));

    const pool = saturatedPool(25);
    registerPgPool('extended', pool);

    // Occupies the single slot forever. Never awaited; the catch only keeps an
    // eventual rejection from surfacing as an unhandled one.
    void pool.connect().catch(() => undefined);

    await expect(pool.connect()).rejects.toThrow(/timeout exceeded when trying to connect/);

    const exhausted = seen.filter((o) => o.outcome === 'pool_exhausted');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]?.role).toBe('extended');
    expect(exhausted[0]?.waitSeconds).toBeGreaterThan(0);
    expect(exhausted[0]?.waitSeconds).toBeLessThan(5);

    expect(getPgPoolStats()[0]).toMatchObject({ poolExhaustedTimeouts: 1, connectTimeouts: 0 });
  });

  it('keeps counting through pool.query(), which funnels into the same connect()', async () => {
    const seen: PgAcquireObservation[] = [];
    addPgAcquireObserver((o) => seen.push(o));

    const pool = saturatedPool(25);
    registerPgPool('platform-admin', pool);
    void pool.connect().catch(() => undefined);

    await expect(pool.query('SELECT 1')).rejects.toThrow(/timeout exceeded when trying to connect/);
    expect(seen.some((o) => o.outcome === 'pool_exhausted' && o.role === 'platform-admin')).toBe(true);
  });

  it('an observer that throws does not break the acquire it is observing', async () => {
    addPgAcquireObserver(() => {
      throw new Error('a metrics registry conflict must never fail a query');
    });
    const pool = saturatedPool(25);
    registerPgPool('extended', pool);
    void pool.connect().catch(() => undefined);

    await expect(pool.connect()).rejects.toThrow(/timeout exceeded when trying to connect/);
    expect(getPgPoolStats()[0]).toMatchObject({ poolExhaustedTimeouts: 1 });
  });

  it('stops delivering to an unsubscribed observer', async () => {
    const seen: PgAcquireObservation[] = [];
    const off = addPgAcquireObserver((o) => seen.push(o));
    off();

    const pool = saturatedPool(25);
    registerPgPool('extended', pool);
    void pool.connect().catch(() => undefined);
    await expect(pool.connect()).rejects.toThrow();

    expect(seen).toHaveLength(0);
    // …but the internal tally is unaffected, so a late subscriber still sees history.
    expect(getPgPoolStats()[0]).toMatchObject({ poolExhaustedTimeouts: 1 });
  });
});

describe('pool retirement', () => {
  it('drops an ended pool but carries its timeout tally forward (a counter never falls)', async () => {
    const pool = saturatedPool(25);
    registerPgPool('vault', pool);
    void pool.connect().catch(() => undefined);
    await expect(pool.connect()).rejects.toThrow();
    expect(getPgPoolStats()[0]).toMatchObject({ role: 'vault', pools: 1, poolExhaustedTimeouts: 1 });

    // `end()` never settles while a client is stuck connecting; `ending` is set
    // synchronously, which is the flag retirement reads.
    void pool.end().catch(() => undefined);

    const after = getPgPoolStats();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ role: 'vault', pools: 0, poolExhaustedTimeouts: 1 });
  });
});

describe('createObservedPgAdapter', () => {
  it('registers the pool Prisma actually built, under the role it was given', async () => {
    // `PrismaPg.connect()` constructs a lazy `pg.Pool`; no socket is opened
    // until a query runs, so this needs no database.
    const adapter = await createObservedPgAdapter('extended', { connectionString: 'postgresql://u:p@127.0.0.1:1/db', max: 7 }).connect();

    expect(getPgPoolStats()).toEqual([expect.objectContaining({ role: 'extended', pools: 1, max: 7 })]);

    await adapter.dispose();
  });

  it('registers a SECOND adapter as its own role — a rotation is not a leak of the first', async () => {
    const extended = await createObservedPgAdapter('extended', { connectionString: 'postgresql://u:p@127.0.0.1:1/db', max: 3 }).connect();
    const vault = await createObservedPgAdapter('vault', { connectionString: 'postgresql://u:p@127.0.0.1:1/db', max: 4 }).connect();

    const byRole = Object.fromEntries(getPgPoolStats().map((s) => [s.role, s.max]));
    expect(byRole).toEqual({ extended: 3, vault: 4 });

    await extended.dispose();
    await vault.dispose();
  });
});
