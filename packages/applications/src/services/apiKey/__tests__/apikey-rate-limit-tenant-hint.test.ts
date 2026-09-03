/**
 * The API-key → tenant hint that `TieredThrottlerGuard` reads.
 *
 * The contract worth pinning is not "it caches" — it is the three properties
 * that make caching SAFE on a pre-auth hot path:
 *   1. it never reads the database,
 *   2. it never throws, and
 *   3. a miss is silent, so the throttler under-attributes rather than guessing.
 */
import { describe, it, expect, vi } from 'vitest';
import { ApiKeyService } from '../apikey.service';

const PREFIX = 'ratelimit:apikey-tenant:';
const RAW_KEY = 'hope_sk_test_rawkey';
const TENANT = '11111111-1111-1111-1111-111111111111';

function makeService(redis?: unknown) {
  return new ApiKeyService(
    // Repositories are deliberately EMPTY objects: a peek that touched one
    // would throw here, which is exactly the regression this shape catches.
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    { get: vi.fn(), set: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    redis as never,
  );
}

describe('ApiKeyService.peekTenantForRateLimit', () => {
  it('returns the tenant from the Redis hint without touching the database', async () => {
    const hash = ApiKeyService.hashKey(RAW_KEY);
    const redis = { get: vi.fn(async (key: string) => (key === `${PREFIX}${hash}` ? TENANT : null)), setex: vi.fn() };

    await expect(makeService(redis).peekTenantForRateLimit(RAW_KEY)).resolves.toBe(TENANT);
    expect(redis.get).toHaveBeenCalledWith(`${PREFIX}${hash}`);
  });

  it('keys the hint on the STORAGE HASH, never the raw key', async () => {
    const redis = { get: vi.fn(async () => null), setex: vi.fn() };
    await makeService(redis).peekTenantForRateLimit(RAW_KEY);

    const key = redis.get.mock.calls[0][0] as string;
    expect(key).not.toContain(RAW_KEY);
    expect(key).toBe(`${PREFIX}${ApiKeyService.hashKey(RAW_KEY)}`);
  });

  it('returns null on a cold hint — the throttler then rides the platform lane', async () => {
    const redis = { get: vi.fn(async () => null), setex: vi.fn() };
    await expect(makeService(redis).peekTenantForRateLimit(RAW_KEY)).resolves.toBeNull();
  });

  it('returns null — never throws — when Redis is down', async () => {
    // Rate limiting must never fail a request over its own bookkeeping.
    const redis = {
      get: vi.fn(async () => {
        throw new Error('redis down');
      }),
      setex: vi.fn(),
    };
    await expect(makeService(redis).peekTenantForRateLimit(RAW_KEY)).resolves.toBeNull();
  });

  it('is inert when no Redis is wired, rather than degrading to a DB read', async () => {
    await expect(makeService(undefined).peekTenantForRateLimit(RAW_KEY)).resolves.toBeNull();
  });

  it('returns null for an empty key without calling Redis at all', async () => {
    const redis = { get: vi.fn(), setex: vi.fn() };
    await expect(makeService(redis).peekTenantForRateLimit('')).resolves.toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });
});
