/**
 * TASK-307 W1.1 — RefreshTokenService unit tests
 *
 * Closes audit findings:
 *   - C-1 (refresh token forgery) — opaque, server-persisted, single-use,
 *     family-revoke on reuse-detection (RFC 6749 §10.4).
 *   - C-12 (refresh ignores tenant scope) — `issue(...)` records the
 *     active session's tenantId; `consume(...)` returns it so the
 *     refreshed access token can bind to the original tenant.
 *   - D-10 (refresh leaks userId) — opaque base64url payload, no
 *     userId / timestamp in the wire format.
 *
 * Pattern mirrors the existing JwtRevocationService tests
 * (`jwt-revocation.service.test.ts`) — direct construction with a
 * mock `IRedisCacheService`, no Nest container.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RefreshTokenService } from '../refresh-token.service';

interface MockCache {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  setex: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  delMany: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  lpush: ReturnType<typeof vi.fn>;
  rpush: ReturnType<typeof vi.fn>;
  hset: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
}

/**
 * Builds a stub `IRedisCacheService` whose `setex` / `get` / `del` /
 * `delMany` / `keys` collaborate on a single in-memory Map so the
 * round-trip tests can mimic the real Redis behaviour.
 */
function createMockCache(): { mock: MockCache; store: Map<string, string> } {
  const store = new Map<string, string>();
  const mock: MockCache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    delMany: vi.fn(async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    }),
    keys: vi.fn(async (pattern: string) => {
      const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return Array.from(store.keys()).filter((k) => re.test(k));
    }),
    exists: vi.fn(async (key: string) => store.has(key)),
    publish: vi.fn(),
    lpush: vi.fn(),
    rpush: vi.fn(),
    hset: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
  };
  return { mock, store };
}

describe('TASK-307 W1.1 — RefreshTokenService', () => {
  let cache: ReturnType<typeof createMockCache>;
  let service: RefreshTokenService;
  const originalEnvTtl = process.env.REFRESH_TOKEN_TTL_SECONDS;

  beforeEach(() => {
    cache = createMockCache();
    service = new RefreshTokenService(cache.mock as never);
  });

  afterEach(() => {
    if (originalEnvTtl === undefined) {
      delete process.env.REFRESH_TOKEN_TTL_SECONDS;
    } else {
      process.env.REFRESH_TOKEN_TTL_SECONDS = originalEnvTtl;
    }
  });

  describe('issue', () => {
    it('returns an opaque base64url token (no userId / timestamp leak) — D-10', async () => {
      const { rawToken } = await service.issue({
        userId: 'user-001',
        tenantId: 'tenant-A',
        jti: 'jti-1',
      });

      // Must NOT match the legacy `refresh_<userId>_<ts>_<hex>` format.
      expect(rawToken).not.toMatch(/^refresh_/);
      expect(rawToken).not.toContain('user-001');

      // Must be a base64url payload of at least 48 bytes (~64 chars).
      expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(rawToken.length).toBeGreaterThanOrEqual(64);
    });

    it('generates a unique family id when none is supplied', async () => {
      const a = await service.issue({ userId: 'u1', tenantId: 't1', jti: 'j1' });
      const b = await service.issue({ userId: 'u1', tenantId: 't1', jti: 'j2' });

      expect(a.family).not.toBe(b.family);
      expect(a.family).toMatch(/^[0-9a-f]{32}$/);
      expect(b.family).toMatch(/^[0-9a-f]{32}$/);
    });

    it('threads an explicit family through to the persisted record (rotation continuity)', async () => {
      const issued = await service.issue({
        userId: 'u1',
        tenantId: 't1',
        jti: 'j1',
        family: 'family-abc',
      });

      expect(issued.family).toBe('family-abc');

      // Family-member marker must exist with the supplied family id.
      const memberKeys = Array.from(cache.store.keys()).filter((k) => k.startsWith('refresh-token-family:family-abc:'));
      expect(memberKeys.length).toBe(1);
    });

    it('persists only the sha256 hash of the raw token (server-side verification — C-1)', async () => {
      const { rawToken } = await service.issue({
        userId: 'u1',
        tenantId: 't1',
        jti: 'j1',
      });

      // The raw token MUST NOT appear in any Redis key or value.
      for (const [key, value] of cache.store.entries()) {
        expect(key).not.toContain(rawToken);
        expect(value).not.toContain(rawToken);
      }
    });

    it('writes the record with userId + tenantId + jti + family + expiresAt', async () => {
      const issued = await service.issue({
        userId: 'doctor-001',
        tenantId: 'tenant-A',
        jti: 'jti-active',
      });

      const refreshKeys = Array.from(cache.store.keys()).filter((k) => k.startsWith('refresh-token:'));
      expect(refreshKeys.length).toBe(1);
      const record = JSON.parse(cache.store.get(refreshKeys[0])!);
      expect(record).toMatchObject({
        userId: 'doctor-001',
        tenantId: 'tenant-A',
        jti: 'jti-active',
        family: issued.family,
      });
      expect(typeof record.expiresAt).toBe('number');
      expect(record.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('uses the default 7-day TTL (604800 s) when REFRESH_TOKEN_TTL_SECONDS is unset', async () => {
      delete process.env.REFRESH_TOKEN_TTL_SECONDS;
      const freshService = new RefreshTokenService(cache.mock as never);

      await freshService.issue({ userId: 'u1', tenantId: 't1', jti: 'j1' });

      // Both setex calls (active row + family member) get the same TTL.
      for (const call of cache.mock.setex.mock.calls) {
        expect(call[1]).toBe(7 * 24 * 60 * 60);
      }
    });

    it('honours REFRESH_TOKEN_TTL_SECONDS env override', async () => {
      process.env.REFRESH_TOKEN_TTL_SECONDS = '3600';
      const freshService = new RefreshTokenService(cache.mock as never);

      await freshService.issue({ userId: 'u1', tenantId: 't1', jti: 'j1' });

      for (const call of cache.mock.setex.mock.calls) {
        expect(call[1]).toBe(3600);
      }
    });
  });

  describe('consume', () => {
    it('round-trip: issue → consume returns the recorded user/tenant/jti/family (C-1)', async () => {
      const issued = await service.issue({
        userId: 'doctor-001',
        tenantId: 'tenant-A',
        jti: 'jti-active',
      });

      const consumed = await service.consume(issued.rawToken);

      expect(consumed).toEqual({
        userId: 'doctor-001',
        tenantId: 'tenant-A',
        jti: 'jti-active',
        family: issued.family,
      });
    });

    it('carries forward the original session tenantId on consume — AC-3 / C-12', async () => {
      // Multi-tenant user is logged into tenant B (not their User.tenantId).
      const issued = await service.issue({
        userId: 'doctor-multi',
        tenantId: 'tenant-B',
        jti: 'jti-B',
      });

      const consumed = await service.consume(issued.rawToken);

      // The consume return MUST carry tenant-B forward so the refreshed
      // access token does not silently switch to User.tenantId.
      expect(consumed.tenantId).toBe('tenant-B');
    });

    it('is single-use: second consume of the same token throws UnauthorizedException (C-1)', async () => {
      const { rawToken } = await service.issue({
        userId: 'u1',
        tenantId: 't1',
        jti: 'j1',
      });

      await service.consume(rawToken);
      await expect(service.consume(rawToken)).rejects.toMatchObject({
        status: 401,
      });
    });

    it('reuse-detection: replaying a consumed token revokes the ENTIRE family (RFC 6749 §10.4)', async () => {
      // T1 is issued and consumed; T2 is then rotated in the same family.
      const t1 = await service.issue({ userId: 'u1', tenantId: 't1', jti: 'j1' });
      await service.consume(t1.rawToken);
      const t2 = await service.issue({
        userId: 'u1',
        tenantId: 't1',
        jti: 'j2',
        family: t1.family,
      });

      // Replaying T1 → reuse detected → entire family revoked.
      await expect(service.consume(t1.rawToken)).rejects.toMatchObject({ status: 401 });

      // T2 must now be unusable as well.
      await expect(service.consume(t2.rawToken)).rejects.toMatchObject({ status: 401 });
    });

    it('rejects an unknown / forged token with no family side effects', async () => {
      await expect(service.consume('forged-base64url-token-zzz')).rejects.toMatchObject({
        status: 401,
      });

      // No family revoke should have been triggered (no consumed marker exists for an unknown token).
      expect(cache.mock.delMany).not.toHaveBeenCalled();
    });

    it('rejects an empty / missing token', async () => {
      await expect(service.consume('')).rejects.toMatchObject({ status: 401 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(service.consume(undefined as any)).rejects.toMatchObject({ status: 401 });
    });
  });

  describe('revokeFamily', () => {
    it('deletes every member of the named family (covers logout — AC-2)', async () => {
      const t1 = await service.issue({ userId: 'u1', tenantId: 't1', jti: 'j1' });
      const t2 = await service.issue({
        userId: 'u1',
        tenantId: 't1',
        jti: 'j2',
        family: t1.family,
      });

      await service.revokeFamily(t1.family);

      await expect(service.consume(t1.rawToken)).rejects.toMatchObject({ status: 401 });
      await expect(service.consume(t2.rawToken)).rejects.toMatchObject({ status: 401 });

      // No active or family-member key for this family should remain.
      const remaining = Array.from(cache.store.keys()).filter(
        (k) => k.startsWith(`refresh-token-family:${t1.family}:`) || k.startsWith('refresh-token:'),
      );
      expect(remaining).toEqual([]);
    });

    it('is a no-op for an empty family id', async () => {
      await expect(service.revokeFamily('')).resolves.toBeUndefined();
      expect(cache.mock.delMany).not.toHaveBeenCalled();
    });
  });
});
