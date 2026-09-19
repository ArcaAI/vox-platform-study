/**
 * TASK-993 lane J, item 1 (defect D-2) — one breach must not cost a full
 * minute.
 *
 * `@nestjs/throttler@6.5.0` resolves
 * `blockDuration = routeOrClass || namedThrottler.blockDuration || ttl`
 * (`throttler.guard.js:84`) and nothing ever configured one, so a single
 * request over the line refused the bucket for 60 s measured FROM THE BREACH.
 *
 * The fix could not be a smaller `blockDuration`, because the two storage
 * backends this platform runs do not agree on what one means. That claim is
 * not taken on faith: the `it` below drives the REAL in-memory service, and
 * the Redis half was measured against a live Redis (see the parity suite at
 * the bottom of this file, and `window-only-storage.ts` for the table).
 *
 * To re-run the Redis half:
 *   THROTTLE_STORAGE_PARITY_REDIS_URL=redis://localhost:6379 \
 *     npx vitest run apps/api/src/modules/throttle/__tests__/window-only-storage.task993.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import { WindowOnlyThrottlerStorage } from '../window-only-storage';

const NO_LOCKOUT = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Records exactly what the wrapper asked the backend for. */
function recordingBackend(): { storage: ThrottlerStorage; calls: Array<{ ttl: number; limit: number; blockDuration: number }> } {
  const calls: Array<{ ttl: number; limit: number; blockDuration: number }> = [];
  const inner = new ThrottlerStorageService();
  return {
    calls,
    storage: {
      increment: (key, ttl, limit, blockDuration, name) => {
        calls.push({ ttl, limit, blockDuration });
        return inner.increment(key, ttl, limit, blockDuration, name);
      },
    },
  };
}

describe('WindowOnlyThrottlerStorage — what a breach costs', () => {
  it('refuses while the window counter is over the limit, and reports the window as the wait', async () => {
    const store = new WindowOnlyThrottlerStorage(new ThrottlerStorageService());
    const key = 'wo:basic';

    for (let i = 1; i <= 3; i++) {
      const r = await store.increment(key, 60_000, 3, NO_LOCKOUT, 'default');
      expect(r.isBlocked, `request ${i} inside the limit`).toBe(false);
    }

    const refused = await store.increment(key, 60_000, 3, NO_LOCKOUT, 'default');
    expect(refused.isBlocked).toBe(true);
    // `Retry-After` is rendered from this. It used to be a flat 60 regardless
    // of how much of the window was actually left.
    expect(refused.timeToBlockExpire).toBe(refused.timeToExpire);
    expect(refused.timeToBlockExpire).toBeGreaterThan(0);
    expect(refused.timeToBlockExpire).toBeLessThanOrEqual(60);

    // Still refused while the window is open — a breach is not a free pass.
    expect((await store.increment(key, 60_000, 3, NO_LOCKOUT, 'default')).isBlocked).toBe(true);
  });

  it('recovers when the window rolls, NOT a fixed interval after the breach', async () => {
    const store = new WindowOnlyThrottlerStorage(new ThrottlerStorageService());
    const key = 'wo:recovery';

    await store.increment(key, 300, 2, NO_LOCKOUT, 'default');
    await store.increment(key, 300, 2, NO_LOCKOUT, 'default');
    expect((await store.increment(key, 300, 2, NO_LOCKOUT, 'default')).isBlocked).toBe(true);

    await sleep(420);

    const after = await store.increment(key, 300, 2, NO_LOCKOUT, 'default');
    expect(after.isBlocked).toBe(false);
    expect(after.totalHits).toBe(1);
  });

  it('DOCUMENTS the trap: the raw in-memory backend reads blockDuration 0 as "no limit at all"', async () => {
    // This is why the wrapper exists rather than a config value. Handed a
    // literal 0, the library's own store ALLOWS the breaching request and
    // resets the counter, so the limit can never be enforced. (Redis handed
    // the same 0 answers `ERR invalid expire time in 'set' command` from
    // `SET blockKey 1 PX 0` inside its Lua — a 500 where a 429 belongs.
    // Measured; the parity suite below re-runs it.)
    const raw = new ThrottlerStorageService();
    const key = 'wo:raw-zero';

    for (let i = 0; i < 3; i++) await raw.increment(key, 60_000, 3, 0, 'default');
    const breaching = await raw.increment(key, 60_000, 3, 0, 'default');

    expect(breaching.isBlocked).toBe(false);
    expect(breaching.totalHits).toBe(1);
    raw.onApplicationShutdown();
  });

  it('never lets a backend see a reachable limit or a non-positive expiry', async () => {
    // The two arguments that keep BOTH backends on their agreeing path: a
    // limit the counter cannot reach (so neither block branch runs) and an
    // expiry Redis will accept if it ever did.
    const { storage, calls } = recordingBackend();
    const store = new WindowOnlyThrottlerStorage(storage);

    await store.increment('wo:args', 60_000, 3, NO_LOCKOUT, 'default');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.limit).toBe(Number.MAX_SAFE_INTEGER);
    expect(calls[0]!.blockDuration).toBeGreaterThan(0);
    expect(calls[0]!.ttl).toBe(60_000);
  });

  it('passes a positive blockDuration straight through, so the legacy posture is byte-identical', async () => {
    const { storage, calls } = recordingBackend();
    const store = new WindowOnlyThrottlerStorage(storage);
    const key = 'wo:legacy';

    for (let i = 0; i < 3; i++) await store.increment(key, 60_000, 2, 60_000, 'default');

    expect(calls.every((c) => c.limit === 2 && c.blockDuration === 60_000)).toBe(true);
    // The backend's own block is in charge again: it freezes the counter.
    const last = await store.increment(key, 60_000, 2, 60_000, 'default');
    expect(last.isBlocked).toBe(true);
    expect(last.timeToBlockExpire).toBe(60);
  });

  it('forwards the lifecycle hooks the wrapped storage declares', () => {
    const shutdown: string[] = [];
    const store = new WindowOnlyThrottlerStorage({
      increment: async () => ({ totalHits: 1, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 }),
      onApplicationShutdown: () => shutdown.push('shutdown'),
      onModuleDestroy: () => shutdown.push('destroy'),
    } as ThrottlerStorage);

    store.onApplicationShutdown();
    store.onModuleDestroy();
    expect(shutdown).toEqual(['shutdown', 'destroy']);
  });
});

/**
 * The parity half. Opt-in, because a unit suite must not depend on a reachable
 * Redis — but committed and re-runnable, because "both backends agree" is the
 * entire justification for the shape of this fix and an assertion nobody can
 * re-execute is not evidence.
 */
const PARITY_URL = process.env.THROTTLE_STORAGE_PARITY_REDIS_URL;

describe.skipIf(!PARITY_URL)('WindowOnlyThrottlerStorage — the two backends agree (live Redis)', () => {
  // Imported lazily so the package is not even loaded on the skipped path.
  const redisStores: Array<{ redis: { keys: (p: string) => Promise<string[]>; del: (...k: string[]) => Promise<number>; quit: () => Promise<unknown> } }> = [];

  afterAll(async () => {
    for (const s of redisStores) {
      const keys = await s.redis.keys('*task993j-parity*');
      if (keys.length) await s.redis.del(...keys);
      await s.redis.quit();
    }
  });

  it('produces the same verdict, the same counter and the same wait on Redis as in memory', async () => {
    const { ThrottlerStorageRedisService } = await import('@nest-lab/throttler-storage-redis');
    const redisBackend = new ThrottlerStorageRedisService(PARITY_URL!);
    redisStores.push(redisBackend as never);

    const memory = new WindowOnlyThrottlerStorage(new ThrottlerStorageService());
    const redis = new WindowOnlyThrottlerStorage(redisBackend);
    const stamp = Date.now();
    const kM = `task993j-parity:mem:${stamp}`;
    const kR = `task993j-parity:redis:${stamp}`;

    for (let i = 1; i <= 5; i++) {
      const m = await memory.increment(kM, 1500, 3, NO_LOCKOUT, 'default');
      const r = await redis.increment(kR, 1500, 3, NO_LOCKOUT, 'default');
      expect({ hits: r.totalHits, blocked: r.isBlocked, wait: r.timeToBlockExpire }, `request ${i}`).toEqual({
        hits: m.totalHits,
        blocked: m.isBlocked,
        wait: m.timeToBlockExpire,
      });
    }

    // …and both recover at the window boundary rather than a minute later.
    await sleep(1700);
    const m = await memory.increment(kM, 1500, 3, NO_LOCKOUT, 'default');
    const r = await redis.increment(kR, 1500, 3, NO_LOCKOUT, 'default');
    expect([r.totalHits, r.isBlocked]).toEqual([m.totalHits, m.isBlocked]);
    expect(r.isBlocked).toBe(false);

    // Nothing wrote a block key: the backends' block branches were unreachable.
    expect(await redisBackend.redis.keys(`*${kR}*blocked*`)).toEqual([]);
  });
});
