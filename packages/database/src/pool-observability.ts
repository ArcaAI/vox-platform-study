/**
 * Saturation telemetry for the `pg.Pool`s that back every Prisma client.
 *
 * ============================================================================
 * WHY THIS EXISTS (TASK-993 OD-3)
 * ============================================================================
 * The owner's answer to "how does the platform scale?" was *"fix the pool and
 * drive the HPA off a saturation signal, not CPU"*. The gateway is I/O-bound:
 * under pool exhaustion requests QUEUE while CPU stays low, so a
 * `Resource / cpu / averageUtilization` trigger can never fire on the real
 * bottleneck. The cluster lane staged that HPA and could not activate it,
 * because **no pool metric existed anywhere** — no depth, no acquire wait, no
 * timeout count. A `connectionTimeoutMillis` rejection was indistinguishable
 * from any other 500.
 *
 * This module is the measurement half. It is deliberately **free of any
 * metrics library**: `packages/database` is imported by seeds, migration
 * scripts and CLI tools that have no Prometheus registry and must not grow a
 * dependency on one. The gateway owns representation
 * (`apps/api/src/observability/prisma-pool-metrics.ts`); this file owns facts.
 *
 * ## The seam, in two directions
 *
 * | Direction | Shape | Why that way |
 * |---|---|---|
 * | **Pull** | {@link getPgPoolStats} | Depth is a *level*, meaningful only at read time. Polling it from a `prom-client` `collect()` callback costs nothing between scrapes. |
 * | **Push** | {@link addPgAcquireObserver} | An acquire wait is an *event*; sampling it at scrape time would miss every observation between scrapes. |
 *
 * The timeout tally is ALSO kept internally (see `PoolEntry.timeouts`) so a
 * consumer that registers late still sees the total, and so a test can assert
 * the count without wiring an observer.
 *
 * ## Why the FACTORY is wrapped, not the pool
 *
 * `PrismaPg` accepts either a `PoolConfig` (it builds the pool) or a
 * caller-supplied `pg.Pool`. Handing it our own pool looks simpler and is
 * wrong here: Prisma calls `factory.connect()` again after a `$disconnect()`,
 * and `VaultPrismaClient.swap()` (dynamic DB credentials) constructs a WHOLE
 * NEW adapter every lease rotation because Vault issues a new *username* and
 * `pg.Pool`'s `user` is fixed at construction. In both cases a
 * caller-supplied pool is dropped and an unobserved one takes its place —
 * the metric would silently read a pool nobody is using any more. Wrapping
 * the factory registers whichever pool `connect()` actually produced, every
 * time, which is the only version of this that survives a rotation.
 *
 * ## Cardinality and privacy
 *
 * The only label is `role` — which of the process's pools this is. There is
 * deliberately **no tenant label**: pool contention is a property of the
 * PROCESS, not of a tenant, so a tenant facet would be both meaningless
 * (every tenant shares the pool) and a topology leak on an endpoint that is
 * scraped by anything on the network path.
 *
 * @module @arcaai/database/pool-observability
 */

import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';

/**
 * Which of the process's pools a sample belongs to.
 *
 * A gateway process holds up to THREE at once, not one:
 *
 * | Role | Owner | Notes |
 * |---|---|---|
 * | `extended` | `getExtendedPrismaClient()` | tenant-scope + soft-delete; nearly every query |
 * | `platform-admin` | `getPlatformAdminPrismaClient_Unscoped()` | `CoreDatabaseService.baseClient`, `$transaction` |
 * | `vault` | `VaultPrismaClient` | dynamic DB credentials (`PG_DYNAMIC_CREDS=true`); ROTATES |
 * | `adhoc` | `createNewPrismaClient()` etc. | tests, scripts; several may coexist |
 *
 * Each is its own `PRISMA_PG_MAX`-sized pool against the same Postgres, which
 * is exactly why the connection budget is `pods × pools × max` and not
 * `pods × max` — see the deployment repo's `pg-connection-budget` gate.
 */
export type PgPoolRole = 'extended' | 'platform-admin' | 'vault' | 'adhoc';

/**
 * How an acquire ended.
 *
 * `pool_exhausted` and `connect_timeout` are BOTH `connectionTimeoutMillis`
 * expiries in `pg-pool`, and they mean opposite things:
 *
 * - **`pool_exhausted`** — every slot was taken and the waiter aged out of the
 *   pending queue. This is saturation: raise `PRISMA_PG_MAX`, or add replicas.
 * - **`connect_timeout`** — a NEW connection could not finish its
 *   TCP/TLS/auth handshake. This is reachability: Postgres is down, slow, or
 *   out of `max_connections`. More pool will not help.
 *
 * Conflating them sends an operator to the wrong lever, which is why they are
 * separate label values rather than one `timeout`.
 */
export type PgAcquireOutcome = 'ok' | 'pool_exhausted' | 'connect_timeout' | 'error';

/** One completed acquire, pushed to every registered observer. */
export interface PgAcquireObservation {
  readonly role: PgPoolRole;
  /**
   * Seconds from `pool.connect()` to its settlement.
   *
   * This is TIME TO ACQUIRE, which includes queue wait AND — when the pool
   * chose to grow rather than queue — the new connection's handshake. Both are
   * latency a request actually paid to get a connection, which is the quantity
   * the HPA cares about; splitting them would need pg-pool internals.
   */
  readonly waitSeconds: number;
  readonly outcome: PgAcquireOutcome;
}

/** A read of one role's pools, aggregated across every pool holding that role. */
export interface PgPoolStats {
  readonly role: PgPoolRole;
  /** How many live pools carry this role (normally 1; `adhoc` may be several). */
  readonly pools: number;
  /** Sum of `max` — the role's total connection ceiling in this process. */
  readonly max: number;
  /** Sum of `totalCount` — connections the pool holds, busy or idle. */
  readonly total: number;
  /** Sum of `idleCount` — established and free. */
  readonly idle: number;
  /** `total - idle`. Connections currently executing a query. */
  readonly inUse: number;
  /**
   * Sum of `waitingCount` — callers BLOCKED waiting for a connection.
   *
   * The single most direct saturation signal this module exports: it is zero
   * whenever the pool is keeping up, and non-zero only when a request is
   * actually stalled. Unlike `inUse` it needs no ratio against `max` to be
   * interpretable.
   */
  readonly waiting: number;
  /** Monotonic count of acquires that ended in `pool_exhausted`. */
  readonly poolExhaustedTimeouts: number;
  /** Monotonic count of acquires that ended in `connect_timeout`. */
  readonly connectTimeouts: number;
}

export type PgAcquireObserver = (observation: PgAcquireObservation) => void;

interface PoolEntry {
  readonly role: PgPoolRole;
  readonly pool: Pool;
  poolExhaustedTimeouts: number;
  connectTimeouts: number;
}

/**
 * Keyed by the pool OBJECT so re-registering the same pool (Prisma may call
 * `connect()` more than once for one pool) is idempotent, and so the tallies
 * survive across those calls.
 */
const pools = new Map<Pool, PoolEntry>();
const observers = new Set<PgAcquireObserver>();

/** All roles, in a fixed order, so a scrape emits a stable series set. */
const ALL_ROLES: readonly PgPoolRole[] = ['extended', 'platform-admin', 'vault', 'adhoc'];

/**
 * `pg-pool` reports an acquire failure only through the rejection it hands the
 * caller — there is no event, and no error code. These are the two literals it
 * constructs (`pg-pool/index.js`, the `connect()` pending-queue timer and the
 * `newClient()` handshake timer). `pg-pool-error-message-parity.test.ts` reads
 * the INSTALLED package and fails if either string moves, so a pg upgrade that
 * renames them is a red test rather than a counter that quietly reads zero.
 */
const POOL_EXHAUSTED_MESSAGE = 'timeout exceeded when trying to connect';
const CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout';

/**
 * Map an acquire rejection onto an {@link PgAcquireOutcome}.
 *
 * @internal — exported for the parity + unit tests.
 */
export function classifyPgAcquireError(error: unknown): PgAcquireOutcome {
  if (error === undefined || error === null) return 'ok';
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(POOL_EXHAUSTED_MESSAGE)) return 'pool_exhausted';
  if (message.includes(CONNECT_TIMEOUT_MESSAGE)) return 'connect_timeout';
  return 'error';
}

/** @internal — the literals the parity test asserts against the installed `pg-pool`. */
export const PG_POOL_TIMEOUT_MESSAGES = {
  poolExhausted: POOL_EXHAUSTED_MESSAGE,
  connectTimeout: CONNECT_TIMEOUT_MESSAGE,
} as const;

function emit(entry: PoolEntry, startedAt: bigint, error: unknown): void {
  const outcome = classifyPgAcquireError(error);
  if (outcome === 'pool_exhausted') entry.poolExhaustedTimeouts += 1;
  else if (outcome === 'connect_timeout') entry.connectTimeouts += 1;

  const waitSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  for (const observer of observers) {
    try {
      observer({ role: entry.role, waitSeconds, outcome });
    } catch {
      // An observer that throws must never break the query it is observing.
      // A missing sample is strictly better than a failed request.
    }
  }
}

/**
 * Wrap `pool.connect` so every acquire is timed and every failure classified.
 *
 * `pool.query()` funnels through `pool.connect()` internally, so this single
 * seam covers BOTH the query path and the explicit-client path Prisma uses for
 * transactions. Both call shapes are preserved exactly: with a callback
 * pg-pool returns `undefined`, without one it returns a promise.
 */
function instrumentConnect(entry: PoolEntry): void {
  const pool = entry.pool;
  const original = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void): void;
  };

  function observedConnect(callback?: (err: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void) {
    const startedAt = process.hrtime.bigint();
    if (typeof callback === 'function') {
      original((err, client, done) => {
        emit(entry, startedAt, err);
        callback(err, client, done);
      });
      return undefined;
    }
    return original().then(
      (client) => {
        emit(entry, startedAt, undefined);
        return client;
      },
      (err: unknown) => {
        emit(entry, startedAt, err);
        throw err;
      },
    );
  }

  (pool as { connect: unknown }).connect = observedConnect;
}

/**
 * Tallies inherited from pools that have since been `end()`ed.
 *
 * A pool is dropped from {@link pools} once it is terminal — `$disconnect()`
 * on shutdown, and every `VaultPrismaClient.swap()` — otherwise the map grows
 * one entry per credential rotation forever. Its counts move HERE first,
 * because a count that falls when a pool retires is not a counter.
 */
const retired = new Map<PgPoolRole, { poolExhaustedTimeouts: number; connectTimeouts: number }>();

/** A pool that has been `end()`ed can never report again; retire it. */
function prune(): void {
  for (const [pool, entry] of pools) {
    // `ending` is set synchronously by `Pool.end()`, before the drain
    // completes — the earliest point at which this pool is terminal.
    if ((pool as unknown as { ending?: boolean }).ending !== true) continue;
    const carried = retired.get(entry.role) ?? { poolExhaustedTimeouts: 0, connectTimeouts: 0 };
    carried.poolExhaustedTimeouts += entry.poolExhaustedTimeouts;
    carried.connectTimeouts += entry.connectTimeouts;
    retired.set(entry.role, carried);
    pools.delete(pool);
  }
}

/**
 * Record a pool under a role and start timing its acquires. Idempotent.
 *
 * @internal — called by {@link createObservedPgAdapter}; not part of the
 * package's public contract.
 */
export function registerPgPool(role: PgPoolRole, pool: Pool): void {
  if (pools.has(pool)) return;
  prune();
  const entry: PoolEntry = { role, pool, poolExhaustedTimeouts: 0, connectTimeouts: 0 };
  pools.set(pool, entry);
  instrumentConnect(entry);
}

/**
 * Current depth of every registered pool, aggregated by role.
 *
 * Returns one row per role in {@link ALL_ROLES} that has at least one
 * registered pool. A role with no pool is ABSENT rather than zero: "this
 * process does not hold a Vault pool" and "it holds an empty one" are
 * different facts, and a gauge that invents the second hides the first.
 */
export function getPgPoolStats(): PgPoolStats[] {
  prune();
  const byRole = new Map<
    PgPoolRole,
    { pools: number; max: number; total: number; idle: number; waiting: number; exhausted: number; connect: number }
  >();

  for (const [role, carried] of retired) {
    byRole.set(role, { pools: 0, max: 0, total: 0, idle: 0, waiting: 0, exhausted: carried.poolExhaustedTimeouts, connect: carried.connectTimeouts });
  }

  for (const entry of pools.values()) {
    const pool = entry.pool;
    const bucket = byRole.get(entry.role) ?? { pools: 0, max: 0, total: 0, idle: 0, waiting: 0, exhausted: 0, connect: 0 };
    bucket.pools += 1;
    bucket.max += Number((pool as unknown as { options?: { max?: number } }).options?.max ?? 0);
    bucket.total += pool.totalCount;
    bucket.idle += pool.idleCount;
    bucket.waiting += pool.waitingCount;
    bucket.exhausted += entry.poolExhaustedTimeouts;
    bucket.connect += entry.connectTimeouts;
    byRole.set(entry.role, bucket);
  }

  const out: PgPoolStats[] = [];
  for (const role of ALL_ROLES) {
    const bucket = byRole.get(role);
    if (!bucket) continue;
    out.push({
      role,
      pools: bucket.pools,
      max: bucket.max,
      total: bucket.total,
      idle: bucket.idle,
      // `totalCount` counts every client the pool holds and `idleCount` the
      // free ones, so the difference is what is executing. Clamped because a
      // pool observed mid-mutation can momentarily report idle > total.
      inUse: Math.max(0, bucket.total - bucket.idle),
      waiting: bucket.waiting,
      poolExhaustedTimeouts: bucket.exhausted,
      connectTimeouts: bucket.connect,
    });
  }
  return out;
}

/**
 * Subscribe to acquire observations. Returns an unsubscribe function.
 *
 * Observers are called SYNCHRONOUSLY on the acquire's settlement, so keep the
 * body to an arithmetic update (a `Histogram.observe`, a `Counter.inc`).
 * A throwing observer is swallowed — see {@link emit}.
 */
export function addPgAcquireObserver(observer: PgAcquireObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

/**
 * Drop every registered pool and observer.
 *
 * @internal — test hook only. Nothing in the running system unregisters.
 */
export function resetPgPoolObservability(): void {
  pools.clear();
  observers.clear();
  retired.clear();
}

/**
 * Build a `PrismaPg` adapter factory whose pools register themselves.
 *
 * Drop-in for `new PrismaPg(config)`. The only behavioural difference is the
 * `registerPgPool` call on each `connect()`; pool construction, disposal and
 * shadow-DB handling stay entirely Prisma's.
 */
export function createObservedPgAdapter(role: PgPoolRole, config: PoolConfig): PrismaPg {
  return new ObservedPrismaPg(role, config);
}

class ObservedPrismaPg extends PrismaPg {
  readonly #role: PgPoolRole;

  constructor(role: PgPoolRole, config: PoolConfig) {
    super(config);
    this.#role = role;
  }

  override async connect() {
    const adapter = await super.connect();
    // `underlyingDriver()` is @prisma/adapter-pg's documented accessor for the
    // pool it built (or was handed). Reading it here — rather than
    // constructing the pool ourselves — is what keeps a Vault credential
    // rotation observable: `swap()` discards this adapter and builds another,
    // and the next `connect()` registers THAT pool.
    try {
      registerPgPool(this.#role, adapter.underlyingDriver());
    } catch {
      // Telemetry must never stop a client from connecting.
    }
    return adapter;
  }
}
