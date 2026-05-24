/**
 * Vault-backed PrismaClient factory (TASK-302 Phase 5 Task 5.5 — Stream B).
 *
 * Wires `@prisma/adapter-pg` to a Vault-issued short-lived credential
 * from the database secrets engine (`database/creds/<role>`). The
 * issued `{ username, password }` pair drives a pg.Pool which the
 * PrismaPg adapter wraps; the wrapper class encapsulates lease
 * lifecycle (rotate, drain, disconnect) so the VaultLeaseRenewer
 * (Task 5.7) can safely swap the pool when the lease nears expiry.
 *
 * Gate-5 design promises:
 *   1. The credential pair is held in a single private field; it is
 *      never stringified, never logged, never written to disk.
 *   2. The pool is rebuilt — not merely refreshed in place — on swap,
 *      because pg.Pool's `user` field is fixed at construction and
 *      Vault dynamic users come with a fresh username every lease.
 *   3. `disconnect()` is idempotent and drains in-flight queries
 *      before tearing down the pool.
 *   4. The Prisma surface is unchanged from the consumer's view: the
 *      `client` getter returns a stock PrismaClient with the same
 *      query shape downstream repositories already use.
 *
 * Limitations (deliberate, documented):
 *   - Username rotation requires a pool rebuild (see #2 above). The
 *     renewer (Task 5.7) is responsible for calling `swap()` ahead of
 *     lease expiry. Without an active renewer, queries WILL FAIL when
 *     the lease's underlying PG user is dropped by Vault revocation.
 *   - The PgBouncer-userlist tension (Gate 5, decision Q2) is NOT
 *     resolved at this layer; the wrapper assumes the credential
 *     pair authenticates against whatever is on port `PG_PORT`.
 *     Production cutover (Phase 7) must decide between auth_query
 *     (preferred), Vault static roles, or direct-PG bypass.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig as PgPoolConfig } from 'pg';
import { PrismaClient } from './generated/core-prisma-client/client.js';

/** Shape returned by Vault's database/creds/<role>. */
export interface DbCredential {
  username: string;
  password: string;
  leaseId: string;
  ttlSec: number;
}

/** Minimum SecretsService surface required by the Vault factory. */
export interface VaultDbSecretsLike {
  requestDbCredential(role: string): Promise<DbCredential>;
}

/**
 * Pool tunables. Defaults mirror Stream C's createPrismaClient() so a
 * Vault-backed pool occupies the same connection budget as a static one.
 */
export interface VaultPrismaClientOpts {
  host?: string;
  port?: number;
  database?: string;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  ssl?: PgPoolConfig['ssl'];
}

/**
 * Resolved base config the adapter consumes. We deliberately return an
 * anonymous structural type (not `PoolConfig`) so the object can flow
 * into PrismaPg's constructor without colliding with the duplicate
 * `@types/pg` declarations that ship inside @prisma/adapter-pg.
 */
interface ResolvedBaseConfig {
  host: string;
  port: number;
  database: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  ssl?: PgPoolConfig['ssl'];
}

/**
 * Resolve pool config from env + opts. Centralised so the convenience
 * function and the class API derive the same defaults.
 */
function resolveBaseConfig(opts: VaultPrismaClientOpts): ResolvedBaseConfig {
  const rawMax = opts.max ?? Number(process.env.PRISMA_PG_MAX ?? 5);
  if (!Number.isInteger(rawMax) || rawMax <= 0) {
    throw new Error(
      `VaultPrismaClient: max must be a positive integer; got ${JSON.stringify(rawMax)}`,
    );
  }
  const out: ResolvedBaseConfig = {
    host: opts.host ?? process.env.PG_HOST ?? 'localhost',
    port: opts.port ?? Number(process.env.PG_PORT ?? 5432),
    database: opts.database ?? process.env.PG_DATABASE ?? 'hope_main',
    max: rawMax,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: opts.idleTimeoutMillis ?? 300_000,
  };
  if (opts.ssl !== undefined) {
    out.ssl = opts.ssl;
  }
  return out;
}

/**
 * VaultPrismaClient — owns the Vault credential → pg.Pool → PrismaPg
 * → PrismaClient chain. Use `VaultPrismaClient.create(...)` to
 * construct (async factory), then read `.client` to get a stock
 * PrismaClient instance for downstream consumers.
 *
 * Lifecycle:
 *   create() → client used → [renewer calls swap() near lease expiry]
 *           → ... → disconnect() on pod shutdown
 *
 * The class deliberately hides the credential from every observable
 * surface: it is held inside a non-enumerable `current` field
 * (declared with a get-trap below) and never reachable via
 * `JSON.stringify(wrapper)`.
 */
export class VaultPrismaClient {
  /**
   * The credential lives behind a non-enumerable property so accidental
   * structured-clone or JSON.stringify on the wrapper does not include it.
   * We deliberately do NOT keep a handle to the pg.Pool here — the
   * PrismaPg adapter constructs the pool internally from PoolConfig and
   * owns the `end()` call via PrismaClient.$disconnect. Skipping the
   * direct Pool import also dodges an @types/pg version-skew mismatch
   * between the workspace's pg@8.20 and adapter-pg's bundled pg@8.11
   * declarations.
   */
  private current!: { cred: DbCredential; client: PrismaClient };
  private destroyed = false;

  /**
   * Async factory. Performs the initial credential fetch + pool/client
   * construction in a single awaitable so callers can `await` once and
   * receive a fully-initialised wrapper.
   */
  static async create(
    secrets: VaultDbSecretsLike,
    role: string = 'hope-app-role',
    opts: VaultPrismaClientOpts = {},
  ): Promise<VaultPrismaClient> {
    const instance = new VaultPrismaClient(secrets, role, opts);
    await instance.acquire();
    return instance;
  }

  private constructor(
    private readonly secrets: VaultDbSecretsLike,
    private readonly role: string,
    private readonly opts: VaultPrismaClientOpts,
  ) {
    Object.defineProperty(this, 'current', { enumerable: false, writable: true, configurable: true });
  }

  /**
   * Request a fresh credential, build an adapter + client, store the
   * pair in `current`. Used by both initial create() and swap(). The
   * PrismaPg adapter accepts PoolConfig directly and owns the
   * underlying pg.Pool's lifecycle, so calling
   * `previousClient.$disconnect()` cleanly drains the old socket pool
   * without us holding a Pool reference.
   */
  private async acquire(): Promise<void> {
    const cred = await this.secrets.requestDbCredential(this.role);
    const base = resolveBaseConfig(this.opts);
    const adapter = new PrismaPg({
      ...base,
      user: cred.username,
      password: cred.password,
    });
    const client = new PrismaClient({ adapter });
    this.current = { cred, client };
  }

  /**
   * Active PrismaClient. Use this for all downstream queries.
   * Throws after disconnect().
   */
  get client(): PrismaClient {
    if (this.destroyed) {
      throw new Error('VaultPrismaClient: disconnected; cannot access client');
    }
    return this.current.client;
  }

  /** Active Vault lease id (for renewer + observability). */
  get leaseId(): string {
    return this.current.cred.leaseId;
  }

  /** Active lease TTL in seconds (for renewer scheduling). */
  get ttlSec(): number {
    return this.current.cred.ttlSec;
  }

  /**
   * Replace the underlying adapter + client with fresh Vault credentials.
   *
   * Why a full rebuild (not a `password` callback):
   *   Vault's database secrets engine issues a new USERNAME each call,
   *   but pg.Pool's `user` is fixed at construction. The `password`
   *   callback alone cannot rotate the user; only a fresh PrismaPg
   *   (which constructs a fresh internal pg.Pool) can.
   *
   * Grace period:
   *   The previous client is left in place for `graceMs` (default 5s)
   *   so in-flight queries finish on the old credential. After the
   *   grace window, `$disconnect()` drains its pool.
   *
   * The grace window is scheduled with `setTimeout`; we deliberately
   * do NOT `unref()` because we want the timer to keep the event loop
   * alive until the drain completes, otherwise Node could exit with
   * the previous pool still holding sockets open.
   */
  async swap(graceMs = 5_000): Promise<void> {
    if (this.destroyed) {
      throw new Error('VaultPrismaClient: disconnected; cannot swap');
    }
    const previous = this.current;
    await this.acquire();
    setTimeout(() => {
      previous.client.$disconnect().catch(() => {
        /* swallow: shutdown errors do not propagate to the renewer */
      });
    }, graceMs);
  }

  /**
   * Drain the current pool (via PrismaClient.$disconnect) and mark the
   * wrapper as terminal. Idempotent — additional calls are no-ops.
   */
  async disconnect(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.current.client.$disconnect();
  }

  /**
   * JSON safety: ensure structured logging / observability tooling
   * cannot serialise the credential out of the wrapper accidentally.
   */
  toJSON(): { role: string; leaseId: string; ttlSec: number } {
    return {
      role: this.role,
      leaseId: this.destroyed ? '' : this.current?.cred?.leaseId ?? '',
      ttlSec: this.destroyed ? 0 : this.current?.cred?.ttlSec ?? 0,
    };
  }
}

/**
 * Convenience async factory matching the Phase 5 plan's
 * `getPrismaClientWithVault(secrets, role)` signature.
 *
 * Returns a stock PrismaClient ready for use; callers do NOT receive
 * the underlying VaultPrismaClient wrapper, so they cannot call
 * `swap()` or `disconnect()`. Use this for fire-and-forget cases
 * (smoke scripts, ad-hoc tests). For production use where the renewer
 * needs to swap credentials, instantiate VaultPrismaClient directly.
 */
export async function getPrismaClientWithVault(
  secrets: VaultDbSecretsLike,
  role: string = 'hope-app-role',
  opts: VaultPrismaClientOpts = {},
): Promise<PrismaClient> {
  const wrapper = await VaultPrismaClient.create(secrets, role, opts);
  return wrapper.client;
}
