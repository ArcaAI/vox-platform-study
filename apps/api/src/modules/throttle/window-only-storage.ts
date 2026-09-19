import type { ThrottlerStorage } from '@nestjs/throttler';
import { RATE_LIMIT_NO_LOCKOUT_BLOCK_MS } from '@arcaai/applications';

// The library exports the storage INTERFACE from its root but not the record
// shape it returns, and a deep `dist/` import would pin an internal path.
type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Makes `blockDuration: 0` mean what everybody assumes it means — "refuse
 * while this window's counter is over the limit, and not one moment longer"
 * — on BOTH storage backends this platform runs (TASK-993 D-2).
 *
 * ## Why a wrapper, and not a configured `blockDuration`
 *
 * `@nestjs/throttler` resolves `blockDuration = routeOrClass ||
 * namedThrottler.blockDuration || ttl`, and nothing configured one, so a
 * breach locked the bucket for a full 60 s **measured from the breach** — not
 * a rolling window that recovers as hits age out.
 *
 * The obvious fix (configure a smaller `blockDuration`) does not work, because
 * the two backends do not agree on what any value below `ttl` means. Measured
 * directly against the real in-memory service and the real Redis Lua, on the
 * running dev Redis:
 *
 * | `blockDuration` | `ThrottlerStorageService` (memory) | `ThrottlerStorageRedisService` |
 * |---|---|---|
 * | `0`     | the breaching request is **allowed** and the counter resets to 1 — no limit at all | `ERR invalid expire time in 'set' command` — `SET blockKey 1 PX 0` throws inside the Lua, so the request 500s |
 * | `1 ms`  | refuses, and goes on refusing | hands out a **fresh window** (`PTTL` rounds to 0 and the Lua's reset branch fires) |
 * | `< ttl` | on block expiry the counter **resets to a full fresh allowance** | on block expiry the counter is still over the limit, so it **re-blocks to the window boundary** |
 * | `= ttl` | identical | identical |
 *
 * The one self-consistent value is `ttl` — the defect. So the block key has to
 * stop existing, which cannot be expressed to either backend and therefore
 * lives here.
 *
 * ## How
 *
 * The backend is asked to count with a limit it can never reach
 * ({@link NEVER_BLOCKS}), which makes its block branch unreachable — no block
 * key is ever written in Redis, and `isBlocked` is never set in memory — and
 * the refusal is then decided from the counter the backend returned. Both
 * backends are left doing the ONE thing they already agree on: maintaining a
 * counter that expires with its window. Verified identical (same hits, same
 * verdict, same `Retry-After`, both recovering at the window boundary).
 *
 * `timeToBlockExpire` is reported as the window's own remaining time, which is
 * both true and useful: it is what the guard renders into `Retry-After`, where
 * it used to be a flat 60 regardless of how much of the window was left.
 *
 * A `blockDuration` above zero is passed through untouched, so the legacy
 * posture (`rate-limit.lockout.enabled = true`, which sends `ttl`) is exactly
 * the behaviour that shipped before — including a stale block key surviving
 * a flip of the switch, which self-heals within one window.
 */
export class WindowOnlyThrottlerStorage implements ThrottlerStorage {
  /**
   * A limit the counter cannot reach, so the backend's own block branch is
   * dead code for the call. `Number.MAX_SAFE_INTEGER` is exactly representable
   * as the Lua double the Redis script compares against.
   */
  private static readonly NEVER_BLOCKS = Number.MAX_SAFE_INTEGER;

  constructor(private readonly inner: ThrottlerStorage) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    if (blockDuration > RATE_LIMIT_NO_LOCKOUT_BLOCK_MS) {
      return this.inner.increment(key, ttl, limit, blockDuration, throttlerName);
    }

    // `ttl` is passed as the backend's block duration too, purely so nothing
    // downstream can ever see a non-positive expiry: with NEVER_BLOCKS it is
    // never read, and Redis rejects `PX 0` outright.
    const record = await this.inner.increment(key, ttl, WindowOnlyThrottlerStorage.NEVER_BLOCKS, ttl, throttlerName);

    return {
      totalHits: record.totalHits,
      timeToExpire: record.timeToExpire,
      isBlocked: record.totalHits > limit,
      timeToBlockExpire: record.timeToExpire,
    };
  }

  /**
   * Forward the lifecycle hooks the wrapped storages declare — the in-memory
   * service clears its decay timers here, and the Redis one disconnects. Nest
   * calls these on the instance registered as `ThrottlerStorage`, which is now
   * this wrapper rather than the storage itself.
   */
  onApplicationShutdown(signal?: string): void {
    (this.inner as { onApplicationShutdown?: (s?: string) => void }).onApplicationShutdown?.(signal);
  }

  onModuleDestroy(): void {
    (this.inner as { onModuleDestroy?: () => void }).onModuleDestroy?.();
  }
}
