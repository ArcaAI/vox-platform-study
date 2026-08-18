import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STREAM_SESSION_META_KEY_PREFIX,
  STREAM_SESSION_TENANT_KEY_PREFIX,
  StreamSessionTenantBindingService,
} from '../stream-session-tenant-binding.service';

/**
 * StreamSessionTenantBindingService.
 *
 * The `closeStreamSession` endpoint takes a `sessionId` (an opaque STT
 * streaming-session id, not a Prisma row), so the existing
 * `@TenantOwnedResource` model resolvers can't run an ownership check on
 * it directly. Without this service, the only enforcement is the Prisma
 * tenantScope extension on whatever downstream rows
 * `StreamingSessionService.removeSession` happens to touch — which is
 * defence-in-depth but not a route-level guard.
 *
 * This service is the missing piece: when a stream session is created, the
 * gateway writes a `<sessionId> → <tenantId>` mapping (TTL-bounded). When
 * the close endpoint is hit, the global `TenantOwnedResourceInterceptor`
 * looks up the mapping and 404s on tenant mismatch, matching the DEF-C3
 * "no existence leak" posture every other resource model uses.
 */
describe('StreamSessionTenantBindingService', () => {
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

  it('bind() writes a TTL-bounded sessionId → { tenantId, userId } mapping', async () => {
    await service.bind('sess-abc', 'tenant-A', 'user-A', 600);

    const key = `${STREAM_SESSION_TENANT_KEY_PREFIX}sess-abc`;
    expect(cache.mock.setex).toHaveBeenCalledWith(key, 600, JSON.stringify({ tenantId: 'tenant-A', userId: 'user-A' }));
  });

  it('lookup() returns the bound tenantId', async () => {
    await service.bind('sess-1', 'tenant-B', 'user-B', 600);

    expect(await service.lookup('sess-1')).toBe('tenant-B');
  });

  it('lookup() returns null for an unbound sessionId (no existence leak)', async () => {
    expect(await service.lookup('never-bound')).toBeNull();
  });

  it('clear() removes the binding', async () => {
    await service.bind('sess-x', 'tenant-X', 'user-X', 600);
    expect(await service.lookup('sess-x')).toBe('tenant-X');

    await service.clear('sess-x');

    expect(await service.lookup('sess-x')).toBeNull();
  });

  it('lookup() guards against empty / whitespace sessionIds', async () => {
    expect(await service.lookup('')).toBeNull();
    expect(await service.lookup('   ')).toBeNull();
  });

  // ===========================================================================
  // OWNER IDENTITY.
  //
  // The binding used to carry the tenant ALONE, so every gate built on it
  // (ticket mint, refresh-ticket, WS handshake, close/switch) could only ever
  // ask "same tenant?" — and any colleague who learned a sessionId passed.
  // The record now carries the OWNING USER too, which is what makes a
  // same-tenant/different-user check possible at all.
  // ===========================================================================
  describe('owner identity', () => {
    it('lookupBinding() round-trips { tenantId, userId }', async () => {
      await service.bind('sess-owner', 'tenant-A', 'user-A');

      expect(await service.lookupBinding('sess-owner')).toEqual({ tenantId: 'tenant-A', userId: 'user-A' });
    });

    it('lookupBinding() returns null for an unbound sessionId (no existence leak)', async () => {
      expect(await service.lookupBinding('never-bound')).toBeNull();
    });

    it('reads a LEGACY bare-tenantId record as an ownerless binding (rollout compatibility)', async () => {
      // Pre-fix wire format: the raw tenant id, no JSON envelope. Sessions
      // created before this deploy still sit in Redis under the 24h TTL, so
      // the read path must not choke on them. `userId: null` is what the
      // enforcement points treat as "owner unproven" → deny.
      cache.store.set(`${STREAM_SESSION_TENANT_KEY_PREFIX}sess-legacy`, 'tenant-legacy');

      expect(await service.lookupBinding('sess-legacy')).toEqual({ tenantId: 'tenant-legacy', userId: null });
      expect(await service.lookup('sess-legacy')).toBe('tenant-legacy');
    });

    it('records userId: null when no owner is supplied', async () => {
      await service.bind('sess-anon', 'tenant-A');

      expect(await service.lookupBinding('sess-anon')).toEqual({ tenantId: 'tenant-A', userId: null });
    });

    it('lookupBinding() returns null for corrupt or tenant-less records (fail-closed)', async () => {
      cache.store.set(`${STREAM_SESSION_TENANT_KEY_PREFIX}sess-corrupt`, '{not-json');
      cache.store.set(`${STREAM_SESSION_TENANT_KEY_PREFIX}sess-no-tenant`, JSON.stringify({ userId: 'user-A' }));

      expect(await service.lookupBinding('sess-corrupt')).toBeNull();
      expect(await service.lookupBinding('sess-no-tenant')).toBeNull();
      expect(await service.lookup('sess-corrupt')).toBeNull();
    });

    it('lookupBinding() guards against empty / whitespace sessionIds', async () => {
      expect(await service.lookupBinding('')).toBeNull();
      expect(await service.lookupBinding('   ')).toBeNull();
    });
  });

  // ===========================================================================
  // Session meta (negotiated sampleRate) carried from `createStreamSession`
  // to the WS gateway under a sibling TTL-bounded key.
  // ===========================================================================
  describe('session meta', () => {
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
