import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STREAM_SESSION_META_KEY_PREFIX,
  STREAM_SESSION_TENANT_KEY_PREFIX,
  StreamSessionTenantBindingService,
} from '../stream-session-tenant-binding.service';

/**
 * TASK-310 W7.A.9 (AC-3) — StreamSessionTenantBindingService.
 *
 * Closes the carryover gap from TASK-307 W7.A.9: the `closeStreamSession`
 * endpoint takes a `sessionId` (an opaque STT-V2 streaming-session id, not
 * a Prisma row), so the existing `@TenantOwnedResource` model resolvers
 * couldn't run an ownership check. The pre-W7 enforcement was the Prisma
 * tenantScope extension on whatever downstream rows
 * `StreamingSessionService.removeSession` happened to touch — which is
 * defence-in-depth but not a route-level guard.
 *
 * This service is the missing piece: when a stream session is created, the
 * gateway writes a `<sessionId> → <tenantId>` mapping (TTL-bounded). When
 * the close endpoint is hit, the global `TenantOwnedResourceInterceptor`
 * looks up the mapping and 404s on tenant mismatch, matching the DEF-C3
 * "no existence leak" posture every other resource model uses.
 */
describe('StreamSessionTenantBindingService (TASK-310 W7.A.9 / AC-3)', () => {
  const createMockCache = () => {
    const store = new Map<string, string>();
    return {
      mock: {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        setex: vi.fn(async (key: string, _ttl: number, value: string) => {
          store.set(key, value);
        }),
        del: vi.fn(async (key: string) => {
          store.delete(key);
        }),
      },
      store,
    };
  };

  let cache: ReturnType<typeof createMockCache>;
  let service: StreamSessionTenantBindingService;

  beforeEach(() => {
    cache = createMockCache();
    service = new StreamSessionTenantBindingService(cache.mock as never);
  });

  it('bind() writes a TTL-bounded sessionId → tenantId mapping', async () => {
    await service.bind('sess-abc', 'tenant-A', 600);

    const key = `${STREAM_SESSION_TENANT_KEY_PREFIX}sess-abc`;
    expect(cache.mock.setex).toHaveBeenCalledWith(key, 600, 'tenant-A');
    expect(cache.store.get(key)).toBe('tenant-A');
  });

  it('lookup() returns the bound tenantId', async () => {
    await service.bind('sess-1', 'tenant-B', 600);

    expect(await service.lookup('sess-1')).toBe('tenant-B');
  });

  it('lookup() returns null for an unbound sessionId (no existence leak)', async () => {
    expect(await service.lookup('never-bound')).toBeNull();
  });

  it('clear() removes the binding', async () => {
    await service.bind('sess-x', 'tenant-X', 600);
    expect(await service.lookup('sess-x')).toBe('tenant-X');

    await service.clear('sess-x');

    expect(await service.lookup('sess-x')).toBeNull();
  });

  it('lookup() guards against empty / whitespace sessionIds', async () => {
    expect(await service.lookup('')).toBeNull();
    expect(await service.lookup('   ')).toBeNull();
  });

  // ===========================================================================
  // TASK-351 P0-2 (C5) — session meta (negotiated sampleRate) carried from
  // `createStreamSession` to the WS gateway under a sibling TTL-bounded key.
  // ===========================================================================
  describe('session meta (TASK-351 P0-2 / C5)', () => {
    it('bindSessionMeta() writes a TTL-bounded JSON meta record', async () => {
      await service.bindSessionMeta('sess-meta', { sampleRate: 48000 }, 600);

      const key = `${STREAM_SESSION_META_KEY_PREFIX}sess-meta`;
      expect(cache.mock.setex).toHaveBeenCalledWith(key, 600, JSON.stringify({ sampleRate: 48000 }));
    });

    it('lookupSessionMeta() round-trips the bound meta', async () => {
      await service.bindSessionMeta('sess-meta-rt', { sampleRate: 44100 });

      expect(await service.lookupSessionMeta('sess-meta-rt')).toEqual({ sampleRate: 44100 });
    });

    it('lookupSessionMeta() returns null for an unbound sessionId', async () => {
      expect(await service.lookupSessionMeta('never-bound')).toBeNull();
    });

    it('lookupSessionMeta() returns null for corrupt or invalid records', async () => {
      cache.store.set(`${STREAM_SESSION_META_KEY_PREFIX}sess-corrupt`, 'not-json{');
      cache.store.set(`${STREAM_SESSION_META_KEY_PREFIX}sess-bad-rate`, JSON.stringify({ sampleRate: 'high' }));
      cache.store.set(`${STREAM_SESSION_META_KEY_PREFIX}sess-neg-rate`, JSON.stringify({ sampleRate: -1 }));

      expect(await service.lookupSessionMeta('sess-corrupt')).toBeNull();
      expect(await service.lookupSessionMeta('sess-bad-rate')).toBeNull();
      expect(await service.lookupSessionMeta('sess-neg-rate')).toBeNull();
    });

    it('meta methods guard against empty / whitespace sessionIds', async () => {
      await service.bindSessionMeta('   ', { sampleRate: 48000 });
      expect(cache.mock.setex).not.toHaveBeenCalled();
      expect(await service.lookupSessionMeta('')).toBeNull();
    });
  });
});
