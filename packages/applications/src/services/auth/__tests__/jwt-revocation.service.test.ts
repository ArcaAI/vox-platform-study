import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { JwtRevocationService, JWT_REVOCATION_KEY_PREFIX, USER_NBF_TTL_SECONDS } from '../jwt-revocation.service';

interface MockCache {
    get: ReturnType<typeof vi.fn>;
    setex: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
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

function createMockCache(): MockCache {
    return {
        get: vi.fn().mockResolvedValue(null),
        setex: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        del: vi.fn().mockResolvedValue(undefined),
        delMany: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
        exists: vi.fn().mockResolvedValue(false),
        publish: vi.fn().mockResolvedValue(undefined),
        lpush: vi.fn().mockResolvedValue(1),
        rpush: vi.fn().mockResolvedValue(1),
        hset: vi.fn().mockResolvedValue(undefined),
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(true),
        isConnected: vi.fn().mockReturnValue(true),
    };
}

describe('JwtRevocationService', () => {
    let cache: MockCache;
    let service: JwtRevocationService;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-24T15:00:00.000Z'));
        cache = createMockCache();
        service = new JwtRevocationService(cache as never);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('revoke', () => {
        it('should store the jti in Redis with key prefix jwt-revoked:', async () => {
            const futureExpSeconds = Math.floor(new Date('2026-05-24T15:15:00.000Z').getTime() / 1000);

            await service.revoke('impersonate-admin-007-doctor-001-1234', futureExpSeconds);

            expect(cache.setex).toHaveBeenCalledTimes(1);
            const [key, ttl, value] = cache.setex.mock.calls[0];
            expect(key).toBe(`${JWT_REVOCATION_KEY_PREFIX}impersonate-admin-007-doctor-001-1234`);
            expect(value).toBe('1');
            expect(ttl).toBe(15 * 60); // 15 minutes remaining
        });

        it('should clamp TTL to a minimum of 1 second when exp is in the past', async () => {
            const pastExp = Math.floor(new Date('2026-05-24T14:55:00.000Z').getTime() / 1000);

            await service.revoke('expired-jti', pastExp);

            const [, ttl] = cache.setex.mock.calls[0];
            expect(ttl).toBe(1);
        });

        it('should fall back to TTL=1 when exp is undefined', async () => {
            await service.revoke('no-exp-jti', undefined);

            const [, ttl] = cache.setex.mock.calls[0];
            expect(ttl).toBe(1);
        });

        it('should be a no-op when jti is empty string', async () => {
            await service.revoke('', 1234567890);
            expect(cache.setex).not.toHaveBeenCalled();
        });

        it('should not throw when Redis is unavailable (best-effort)', async () => {
            cache.setex.mockRejectedValueOnce(new Error('Redis disconnected'));
            const futureExpSeconds = Math.floor(new Date('2026-05-24T15:15:00.000Z').getTime() / 1000);

            await expect(service.revoke('some-jti', futureExpSeconds)).resolves.toBeUndefined();
        });
    });

    describe('isRevoked', () => {
        it('should return true when the key is present in Redis', async () => {
            cache.get.mockResolvedValueOnce('1');

            await expect(service.isRevoked('impersonate-admin-007-doctor-001-1234')).resolves.toBe(
                true,
            );
            expect(cache.get).toHaveBeenCalledWith(
                `${JWT_REVOCATION_KEY_PREFIX}impersonate-admin-007-doctor-001-1234`,
            );
        });

        it('should return false when the key is absent', async () => {
            cache.get.mockResolvedValueOnce(null);

            await expect(service.isRevoked('fresh-jti')).resolves.toBe(false);
        });

        it('should return false when jti is empty', async () => {
            await expect(service.isRevoked('')).resolves.toBe(false);
            expect(cache.get).not.toHaveBeenCalled();
        });

        it('should return false when Redis lookup throws (fail-open)', async () => {
            cache.get.mockRejectedValueOnce(new Error('Redis down'));

            await expect(service.isRevoked('jti-1')).resolves.toBe(false);
        });
    });

    describe('round-trip: revoke + isRevoked', () => {
        it('marks a token revoked so the very next isRevoked sees it (C-4 acceptance)', async () => {
            const futureExpSeconds = Math.floor(new Date('2026-05-24T15:15:00.000Z').getTime() / 1000);
            const jti = 'impersonate-admin-007-doctor-001-1234';

            // Simulate Redis state across calls.
            const store = new Map<string, string>();
            cache.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
                store.set(key, value);
            });
            cache.get.mockImplementation(async (key: string) => store.get(key) ?? null);

            expect(await service.isRevoked(jti)).toBe(false);
            await service.revoke(jti, futureExpSeconds);
            expect(await service.isRevoked(jti)).toBe(true);
        });
    });

    // ─── degraded-aware revocation check ────────────────────

    describe('checkRevoked (TASK-541 A3)', () => {
        it('reports revoked=false, degraded=false when the jti is absent', async () => {
            cache.get.mockResolvedValueOnce(null);
            await expect(service.checkRevoked('jti-1')).resolves.toEqual({ revoked: false, degraded: false });
        });

        it('reports revoked=true, degraded=false when the jti is present', async () => {
            cache.get.mockResolvedValueOnce('1');
            await expect(service.checkRevoked('jti-1')).resolves.toEqual({ revoked: true, degraded: false });
        });

        it('reports degraded=true when the backing store throws (caller decides the posture)', async () => {
            cache.get.mockRejectedValueOnce(new Error('Redis down'));
            await expect(service.checkRevoked('jti-1')).resolves.toEqual({ revoked: false, degraded: true });
        });

        it('short-circuits an empty jti without touching Redis', async () => {
            await expect(service.checkRevoked('')).resolves.toEqual({ revoked: false, degraded: false });
            expect(cache.get).not.toHaveBeenCalled();
        });

        it('isRevoked stays a thin wrapper over checkRevoked (back-compat)', async () => {
            cache.get.mockResolvedValueOnce('1');
            await expect(service.isRevoked('jti-1')).resolves.toBe(true);
            cache.get.mockRejectedValueOnce(new Error('Redis down'));
            await expect(service.isRevoked('jti-1')).resolves.toBe(false);
        });
    });

    // ─── user-level not-before revocation ───────────────────

    describe('revokeAllForUser (TASK-541 A4)', () => {
        it('stamps the current epoch under auth:user-nbf:<userId> with a bounded TTL', async () => {
            await service.revokeAllForUser('user-123');
            const nowSeconds = Math.floor(new Date('2026-05-24T15:00:00.000Z').getTime() / 1000);
            expect(cache.setex).toHaveBeenCalledWith('auth:user-nbf:user-123', USER_NBF_TTL_SECONDS, String(nowSeconds));
        });

        it('no-ops on an empty userId', async () => {
            await service.revokeAllForUser('');
            expect(cache.setex).not.toHaveBeenCalled();
        });

        it('never throws when Redis is unavailable — the caller mutation must still commit', async () => {
            cache.setex.mockRejectedValueOnce(new Error('Redis down'));
            await expect(service.revokeAllForUser('user-123')).resolves.toBeUndefined();
        });
    });

    describe('getUserNotBefore (TASK-541 A4)', () => {
        it('returns notBefore=null when the user has never been revoked', async () => {
            cache.get.mockResolvedValueOnce(null);
            await expect(service.getUserNotBefore('user-123')).resolves.toEqual({ notBefore: null, degraded: false });
        });

        it('returns the stored epoch when present', async () => {
            cache.get.mockResolvedValueOnce('1748098800');
            await expect(service.getUserNotBefore('user-123')).resolves.toEqual({ notBefore: 1748098800, degraded: false });
        });

        it('treats a malformed stored value as absent rather than as epoch 0', async () => {
            cache.get.mockResolvedValueOnce('not-a-number');
            await expect(service.getUserNotBefore('user-123')).resolves.toEqual({ notBefore: null, degraded: false });
        });

        it('reports degraded=true when the backing store throws', async () => {
            cache.get.mockRejectedValueOnce(new Error('Redis down'));
            await expect(service.getUserNotBefore('user-123')).resolves.toEqual({ notBefore: null, degraded: true });
        });

        it('short-circuits an empty userId without touching Redis', async () => {
            await expect(service.getUserNotBefore('')).resolves.toEqual({ notBefore: null, degraded: false });
            expect(cache.get).not.toHaveBeenCalled();
        });
    });

    describe('round-trip: revokeAllForUser + getUserNotBefore', () => {
        it('a token issued before the revoke stamp is identifiably stale (A4 acceptance)', async () => {
            const store = new Map<string, string>();
            cache.setex.mockImplementation(async (key: string, _ttl: number, value: string) => {
                store.set(key, value);
            });
            cache.get.mockImplementation(async (key: string) => store.get(key) ?? null);

            const tokenIssuedAt = Math.floor(new Date('2026-05-24T14:59:00.000Z').getTime() / 1000);
            expect(await service.getUserNotBefore('user-123')).toEqual({ notBefore: null, degraded: false });
            await service.revokeAllForUser('user-123');
            const { notBefore } = await service.getUserNotBefore('user-123');
            expect(notBefore).not.toBeNull();
            expect(tokenIssuedAt).toBeLessThanOrEqual(notBefore!);
        });
    });
});
